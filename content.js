(() => {
  "use strict";

  const BUTTON_ATTRIBUTE = "data-npd-button";
  const PAUSE_ATTRIBUTE = "data-npd-pause";
  const QUALITY_ATTRIBUTE = "data-npd-quality";
  const RUNNING_ATTRIBUTE = "data-npd-running";
  const DOWNLOAD_INTERVAL = 700;

  const QUALITY_OPTIONS = [
    ["standard", "标准音质"],
    ["higher", "较高音质"],
    ["exhigh", "极高音质"],
    ["lossless", "无损音质"],
    ["hires", "Hi-Res"]
  ];

  function findPlaylistDocument() {
    const iframe = document.querySelector("#g_iframe");

    try {
      const iframeDocument = iframe?.contentDocument;
      if (iframeDocument && getPlaylistId(iframeDocument)) {
        return iframeDocument;
      }
    } catch (_error) {
      // iframe 内的 content script 会继续处理。
    }

    return getPlaylistId(document) ? document : null;
  }

  function getPlaylistId(playlistDocument) {
    const candidates = [];

    try {
      candidates.push(playlistDocument.defaultView?.location?.href ?? "");
    } catch (_error) {
      // 忽略无法读取的 frame URL。
    }

    candidates.push(window.location.href);

    for (const value of candidates) {
      if (!value.includes("/playlist")) {
        continue;
      }

      const matched = value.match(/[?&]id=(\d+)/);
      if (matched) {
        return matched[1];
      }
    }

    return "";
  }

  function ensurePageControls() {
    const playlistDocument = findPlaylistDocument();

    if (!playlistDocument || !getPlaylistId(playlistDocument)) {
      return;
    }

    const operation = playlistDocument.querySelector("#content-operation");
    if (!operation) {
      return;
    }

    let qualitySelect = operation.querySelector(`[${QUALITY_ATTRIBUTE}]`);
    if (!qualitySelect) {
      qualitySelect = playlistDocument.createElement("select");
      qualitySelect.setAttribute(QUALITY_ATTRIBUTE, "true");
      qualitySelect.title = "选择本次批量下载的音质";
      qualitySelect.style.cssFloat = "left";
      qualitySelect.style.height = "31px";
      qualitySelect.style.marginLeft = "8px";
      qualitySelect.style.padding = "0 7px";
      qualitySelect.style.border = "1px solid #c5c5c5";
      qualitySelect.style.borderRadius = "4px";
      qualitySelect.style.background = "#fff";

      for (const [value, label] of QUALITY_OPTIONS) {
        const option = playlistDocument.createElement("option");
        option.value = value;
        option.textContent = label;
        qualitySelect.appendChild(option);
      }

      operation.appendChild(qualitySelect);
    }

    let downloadButton = operation.querySelector(`[${BUTTON_ATTRIBUTE}]`);
    if (!downloadButton) {
      downloadButton = createActionButton(
        playlistDocument,
        BUTTON_ATTRIBUTE,
        "批量下载"
      );

      downloadButton.addEventListener("click", (event) => {
        event.preventDefault();
        startBatch(playlistDocument, qualitySelect.value).catch((error) => {
          console.error("[歌单下载助手] 批量任务异常：", error);
        });
      });

      operation.appendChild(downloadButton);
    }

    let pauseButton = operation.querySelector(`[${PAUSE_ATTRIBUTE}]`);
    if (!pauseButton) {
      pauseButton = createActionButton(
        playlistDocument,
        PAUSE_ATTRIBUTE,
        "暂停"
      );
      pauseButton.style.display = "none";

      pauseButton.addEventListener("click", async (event) => {
        event.preventDefault();
        await togglePause(playlistDocument);
      });

      operation.appendChild(pauseButton);
    }
  }

  function createActionButton(playlistDocument, attribute, label) {
    const button = playlistDocument.createElement("a");
    button.href = "javascript:void(0)";
    button.className = "u-btn2 u-btn2-2 u-btni-addply f-fl";
    button.setAttribute(attribute, "true");
    button.setAttribute("role", "button");
    button.style.marginLeft = "8px";
    button.innerHTML = `<i><em class="ply"></em><span>${label}</span></i>`;
    return button;
  }

  function getControls(playlistDocument) {
    return {
      downloadButton: playlistDocument.querySelector(`[${BUTTON_ATTRIBUTE}]`),
      pauseButton: playlistDocument.querySelector(`[${PAUSE_ATTRIBUTE}]`),
      qualitySelect: playlistDocument.querySelector(`[${QUALITY_ATTRIBUTE}]`)
    };
  }

  async function startBatch(playlistDocument, requestedQuality) {
    const controls = getControls(playlistDocument);
    const label = controls.downloadButton?.querySelector("span");
    const root = playlistDocument.documentElement;

    if (root.getAttribute(RUNNING_ATTRIBUTE) === "true") {
      return { ok: false, error: "当前歌单正在提交下载" };
    }

    const playlistId = getPlaylistId(playlistDocument);
    if (!playlistId) {
      setLabel(label, "没有找到歌单");
      return { ok: false, error: "无法从当前地址读取歌单 ID" };
    }

    const quality = normalizeQuality(requestedQuality);
    root.setAttribute(RUNNING_ATTRIBUTE, "true");
    setControlsRunning(controls, true);
    setLabel(label, "读取歌单…");

    const result = await requestPlaylist(playlistId);
    if (!result.ok) {
      resetRunningState(playlistDocument);
      setLabel(label, "读取失败");
      return result;
    }

    const playlist = result.playlist;
    const beginResult = await sendRuntimeMessage({
      type: "BEGIN_JOB",
      playlistId,
      playlistName: playlist.name,
      quality,
      total: playlist.songs.length
    });

    if (!beginResult.ok) {
      resetRunningState(playlistDocument);
      setLabel(label, "任务已存在");
      return beginResult;
    }

    queueDownloads(playlistDocument, label, playlist, quality).catch(async (error) => {
      console.error("[歌单下载助手] 下载队列异常：", error);
      await sendRuntimeMessage({ type: "END_JOB" }).catch(() => {});
      resetRunningState(playlistDocument);
      setLabel(label, "任务异常");
    });

    return { ok: true, count: playlist.songs.length, quality };
  }

  async function queueDownloads(playlistDocument, label, playlist, quality) {
    const songs = playlist.songs;
    const playlistName = safePathSegment(playlist.name);
    let failed = 0;
    let fallback = 0;

    for (let index = 0; index < songs.length; index += 1) {
      await waitUntilResumed(playlistDocument, label, index, songs.length);

      const song = songs[index];
      const filenameBase =
        `网易云音乐/${playlistName}/` +
        `${safePathSegment(song.name)}-${safePathSegment(song.artist || "未知歌手")}`;

      setLabel(label, `提交 ${index + 1}/${songs.length}`);

      const result = await requestDownload(song.id, filenameBase, quality);
      if (!result.ok) {
        failed += 1;
        console.warn(`[歌单下载助手] ${song.name} 提交失败：${result.error}`);
      } else if (result.level && result.level !== quality) {
        fallback += 1;
      }

      if (index + 1 < songs.length) {
        await delay(DOWNLOAD_INTERVAL);
      }
    }

    await sendRuntimeMessage({ type: "END_JOB", failed, fallback });
    resetRunningState(playlistDocument);

    const messages = [`已提交 ${songs.length - failed} 首`];
    if (failed) {
      messages.push(`失败 ${failed}`);
    }
    if (fallback) {
      messages.push(`音质回落 ${fallback}`);
    }
    setLabel(label, messages.join("，"));
  }

  async function waitUntilResumed(playlistDocument, label, index, total) {
    while (true) {
      const state = await sendRuntimeMessage({ type: "GET_JOB_STATE" });

      if (!state.ok || !state.job?.running) {
        throw new Error(state.error || "下载任务状态已丢失");
      }

      updatePauseControl(playlistDocument, state.job.paused);
      if (!state.job.paused) {
        return;
      }

      setLabel(label, `已暂停 ${index}/${total}`);
      await delay(500);
    }
  }

  async function togglePause(playlistDocument) {
    const state = await sendRuntimeMessage({ type: "GET_JOB_STATE" });
    if (!state.ok || !state.job?.running) {
      return;
    }

    const result = await sendRuntimeMessage({
      type: "SET_JOB_PAUSED",
      paused: !state.job.paused
    });

    if (result.ok) {
      updatePauseControl(playlistDocument, result.job.paused);
    }
  }

  function updatePauseControl(playlistDocument, paused) {
    const pauseButton = playlistDocument.querySelector(`[${PAUSE_ATTRIBUTE}]`);
    const label = pauseButton?.querySelector("span");

    if (pauseButton) {
      pauseButton.style.display = "";
    }
    setLabel(label, paused ? "继续" : "暂停");
  }

  function setControlsRunning(controls, running) {
    if (controls.downloadButton) {
      controls.downloadButton.style.pointerEvents = running ? "none" : "";
      controls.downloadButton.style.opacity = running ? "0.72" : "";
    }

    if (controls.qualitySelect) {
      controls.qualitySelect.disabled = running;
    }

    if (controls.pauseButton) {
      controls.pauseButton.style.display = running ? "" : "none";
      setLabel(controls.pauseButton.querySelector("span"), "暂停");
    }
  }

  function requestPlaylist(playlistId) {
    return sendRuntimeMessage({ type: "FETCH_PLAYLIST", playlistId });
  }

  function requestDownload(id, filenameBase, quality) {
    return sendRuntimeMessage({
      type: "DOWNLOAD_SONG",
      id,
      filenameBase,
      quality
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;

        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }

        resolve(response ?? { ok: false, error: "扩展后台没有响应" });
      });
    });
  }

  function resetRunningState(playlistDocument) {
    playlistDocument.documentElement.removeAttribute(RUNNING_ATTRIBUTE);
    setControlsRunning(getControls(playlistDocument), false);
  }

  function normalizeQuality(value) {
    return QUALITY_OPTIONS.some(([option]) => option === value)
      ? value
      : "standard";
  }

  function safePathSegment(value) {
    let result = String(value ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[.\s]+$/g, "")
      .trim();

    if (!result) {
      result = "未命名";
    }

    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) {
      result = `_${result}`;
    }

    return result.slice(0, 100);
  }

  function setLabel(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  if (window.top === window) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "START_BATCH_DOWNLOAD") {
        return false;
      }

      const playlistDocument = findPlaylistDocument();
      if (!playlistDocument) {
        sendResponse({
          ok: false,
          error: "没有找到歌单。请进入歌单详情页并等待页面加载完成。"
        });
        return false;
      }

      if (playlistDocument.documentElement.getAttribute(RUNNING_ATTRIBUTE) === "true") {
        sendResponse({ ok: false, error: "当前歌单正在提交下载" });
        return false;
      }

      startBatch(playlistDocument, message.quality)
        .then(sendResponse)
        .catch((error) => {
          console.error("[歌单下载助手] 批量任务异常：", error);
          sendResponse({ ok: false, error: error.message || "启动任务失败" });
        });

      return true;
    });
  }

  ensurePageControls();

  const observer = new MutationObserver(() => {
    ensurePageControls();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
