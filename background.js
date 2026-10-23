"use strict";

const QUALITY_LEVELS = new Set([
  "standard",
  "higher",
  "exhigh",
  "lossless",
  "hires"
]);

const downloadOwners = new Map();
const pendingFilenameRequests = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "扩展后台处理失败"
      });
    });

  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") {
    return;
  }

  const tabId = downloadOwners.get(delta.id);
  if (tabId === undefined) {
    return;
  }

  downloadOwners.delete(delta.id);
  removeActiveDownload(tabId, delta.id).catch(() => {});
});

// 部分音乐 CDN 会通过响应头提供对象存储名称。这里在浏览器最终
// 确定文件名时再次指定目标名称，避免保存成 obj_xxx.mp3。
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const requestIndex = pendingFilenameRequests.findIndex((request) =>
    (request.downloadId !== null && request.downloadId === item.id) ||
    request.url === item.finalUrl ||
    request.url === item.url
  );

  if (requestIndex === -1) {
    suggest();
    return;
  }

  const [request] = pendingFilenameRequests.splice(requestIndex, 1);
  suggest({
    filename: request.filename,
    conflictAction: "uniquify"
  });
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "FETCH_PLAYLIST":
      return handleFetchPlaylist(message);
    case "BEGIN_JOB":
      return beginJob(getTabId(message, sender), message);
    case "GET_JOB_STATE":
      return getJobState(getTabId(message, sender));
    case "SET_JOB_PAUSED":
      return setJobPaused(getTabId(message, sender), Boolean(message.paused));
    case "END_JOB":
      return endJob(getTabId(message, sender), message);
    case "DOWNLOAD_SONG":
      return handleSongDownload(getTabId(message, sender), message);
    default:
      return { ok: false, error: "未知操作" };
  }
}

function getTabId(message, sender) {
  const value = Number.isInteger(message?.tabId)
    ? message.tabId
    : sender?.tab?.id;

  if (!Number.isInteger(value)) {
    throw new Error("无法确定当前标签页");
  }

  return value;
}

async function handleFetchPlaylist(message) {
  const playlistId = String(message.playlistId ?? "");

  if (!/^\d+$/.test(playlistId)) {
    throw new Error("歌单 ID 无效");
  }

  return { ok: true, playlist: await fetchPlaylist(playlistId) };
}

async function fetchPlaylist(playlistId) {
  const detail = await fetchJson(
    `https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}`
  );

  if (detail.code !== 200 || !detail.playlist) {
    throw new Error(detail.message || "网易云没有返回歌单数据");
  }

  const trackIds = Array.isArray(detail.playlist.trackIds)
    ? detail.playlist.trackIds.map((item) => String(item.id))
    : [];

  if (!trackIds.length) {
    throw new Error("这个歌单中没有可读取的歌曲");
  }

  const songMap = new Map();

  for (const song of detail.playlist.tracks ?? []) {
    songMap.set(String(song.id), normalizeSong(song));
  }

  const missingIds = trackIds.filter((id) => !songMap.has(id));

  for (let index = 0; index < missingIds.length; index += 100) {
    const chunk = missingIds.slice(index, index + 100).map(Number);
    const ids = encodeURIComponent(JSON.stringify(chunk));
    const response = await fetchJson(
      `https://music.163.com/api/song/detail?ids=${ids}`
    );

    if (response.code !== 200 || !Array.isArray(response.songs)) {
      throw new Error(response.message || "读取歌曲资料失败");
    }

    for (const song of response.songs) {
      songMap.set(String(song.id), normalizeSong(song));
    }
  }

  return {
    id: playlistId,
    name: detail.playlist.name || "网易云歌单",
    songs: trackIds.map((id) => songMap.get(id) ?? {
      id,
      name: `song_${id}`,
      artist: "未知歌手"
    })
  };
}

async function handleSongDownload(tabId, message) {
  const id = String(message.id ?? "");
  const quality = normalizeQuality(message.quality);

  if (!/^\d+$/.test(id)) {
    throw new Error("歌曲 ID 无效");
  }

  try {
    const media = await resolveSongMedia(id, quality);
    const extension = safeExtension(media.type);
    const filenameBase = normalizeDownloadPath(message.filenameBase);

    if (!filenameBase) {
      throw new Error("下载文件名无效");
    }

    const downloadId = await createDownload({
      url: media.url,
      filename: `${filenameBase}.${extension}`
    });

    downloadOwners.set(downloadId, tabId);
    await updateJob(tabId, (job) => ({
      ...job,
      submitted: (job.submitted ?? 0) + 1,
      activeDownloadIds: [...new Set([...(job.activeDownloadIds ?? []), downloadId])],
      updatedAt: Date.now()
    }));

    return {
      ok: true,
      downloadId,
      level: media.level,
      type: extension,
      bitrate: media.bitrate
    };
  } catch (error) {
    await updateJob(tabId, (job) => ({
      ...job,
      failed: (job.failed ?? 0) + 1,
      updatedAt: Date.now()
    })).catch(() => {});
    throw error;
  }
}

async function resolveSongMedia(id, quality) {
  const encodeType = quality === "lossless" || quality === "hires"
    ? "flac"
    : "mp3";
  const ids = encodeURIComponent(JSON.stringify([Number(id)]));
  const response = await fetchJson(
    `https://music.163.com/api/song/enhance/player/url/v1` +
      `?ids=${ids}&level=${quality}&encodeType=${encodeType}`
  );
  const media = response.data?.[0];

  if (response.code !== 200 || !media?.url) {
    throw new Error("歌曲没有返回可下载地址");
  }

  return {
    url: media.url,
    level: media.level || quality,
    type: media.type || (encodeType === "flac" ? "flac" : "mp3"),
    bitrate: media.br || 0
  };
}

async function beginJob(tabId, message) {
  const current = await readJob(tabId);

  if (current?.running) {
    return { ok: false, error: "当前标签页已有下载任务" };
  }

  const job = {
    running: true,
    paused: false,
    playlistId: String(message.playlistId ?? ""),
    playlistName: String(message.playlistName ?? "网易云歌单"),
    quality: normalizeQuality(message.quality),
    total: Number(message.total) || 0,
    submitted: 0,
    failed: 0,
    activeDownloadIds: [],
    startedAt: Date.now(),
    updatedAt: Date.now()
  };

  await writeJob(tabId, job);
  return { ok: true, job };
}

async function getJobState(tabId) {
  return { ok: true, job: (await readJob(tabId)) ?? null };
}

async function setJobPaused(tabId, paused) {
  const job = await readJob(tabId);

  if (!job?.running) {
    return { ok: false, error: "当前没有正在运行的下载任务" };
  }

  const next = { ...job, paused, updatedAt: Date.now() };
  await writeJob(tabId, next);
  await setDownloadPauseState(next.activeDownloadIds ?? [], paused);

  return { ok: true, job: next };
}

async function endJob(tabId, message) {
  const job = await readJob(tabId);

  if (!job) {
    return { ok: true, job: null };
  }

  const next = {
    ...job,
    running: false,
    paused: false,
    failed: Number(message.failed) || job.failed || 0,
    fallback: Number(message.fallback) || 0,
    finishedAt: Date.now(),
    updatedAt: Date.now()
  };

  await writeJob(tabId, next);
  return { ok: true, job: next };
}

async function setDownloadPauseState(downloadIds, paused) {
  await Promise.allSettled(
    downloadIds.map((downloadId) => callDownloadAction(
      paused ? chrome.downloads.pause : chrome.downloads.resume,
      downloadId
    ))
  );
}

function callDownloadAction(action, downloadId) {
  return new Promise((resolve) => {
    action.call(chrome.downloads, downloadId, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function createDownload({ url, filename }) {
  return new Promise((resolve, reject) => {
    const filenameRequest = {
      url,
      filename,
      downloadId: null
    };
    pendingFilenameRequests.push(filenameRequest);

    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        const error = chrome.runtime.lastError;

        if (error || !Number.isInteger(downloadId)) {
          removePendingFilenameRequest(filenameRequest);
          reject(new Error(error?.message || "浏览器没有创建下载任务"));
          return;
        }

        filenameRequest.downloadId = downloadId;
        setTimeout(() => removePendingFilenameRequest(filenameRequest), 60000);
        resolve(downloadId);
      }
    );
  });
}

function removePendingFilenameRequest(request) {
  const index = pendingFilenameRequests.indexOf(request);
  if (index !== -1) {
    pendingFilenameRequests.splice(index, 1);
  }
}

async function removeActiveDownload(tabId, downloadId) {
  await updateJob(tabId, (job) => ({
    ...job,
    activeDownloadIds: (job.activeDownloadIds ?? []).filter((id) => id !== downloadId),
    updatedAt: Date.now()
  }));
}

async function updateJob(tabId, updater) {
  const job = await readJob(tabId);
  if (!job) {
    return null;
  }

  const next = updater(job);
  await writeJob(tabId, next);
  return next;
}

async function readJob(tabId) {
  const key = jobKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? null;
}

async function writeJob(tabId, job) {
  await chrome.storage.session.set({ [jobKey(tabId)]: job });
}

function jobKey(tabId) {
  return `downloadJob:${tabId}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeSong(song) {
  const artists = Array.isArray(song.ar)
    ? song.ar
    : Array.isArray(song.artists)
      ? song.artists
      : [];
  const artist = artists
    .map((item) => item?.name)
    .filter(Boolean)
    .join("、");

  return {
    id: String(song.id),
    name: song.name || `song_${song.id}`,
    artist: artist || "未知歌手"
  };
}

function normalizeQuality(value) {
  return QUALITY_LEVELS.has(value) ? value : "standard";
}

function safeExtension(value) {
  const extension = String(value ?? "").toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(extension) ? extension : "mp3";
}

function normalizeDownloadPath(value) {
  if (typeof value !== "string") {
    return "";
  }

  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");

  return segments.join("/");
}
