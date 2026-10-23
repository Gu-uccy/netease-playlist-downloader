"use strict";

const startButton = document.querySelector("#start");
const pauseButton = document.querySelector("#pause");
const qualitySelect = document.querySelector("#quality");
const status = document.querySelector("#status");

let activeTabId = null;
let currentJob = null;

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  qualitySelect.disabled = true;
  setStatus("正在读取完整歌单……");

  const tab = await getActiveMusicTab();
  if (!tab) {
    resetIdleControls();
    setStatus("请先打开网易云音乐的歌单详情页。", "error");
    return;
  }

  chrome.tabs.sendMessage(
    tab.id,
    {
      type: "START_BATCH_DOWNLOAD",
      quality: qualitySelect.value
    },
    (response) => {
      const error = chrome.runtime.lastError;

      if (error) {
        resetIdleControls();
        setStatus("无法连接页面，请刷新歌单页面后重试。", "error");
        return;
      }

      if (!response?.ok) {
        resetIdleControls();
        setStatus(response?.error || "没有找到可下载的歌单。", "error");
        return;
      }

      currentJob = {
        running: true,
        paused: false,
        total: response.count,
        quality: response.quality
      };
      pauseButton.disabled = false;
      pauseButton.textContent = "暂停任务";
      startButton.textContent = "任务运行中";
      setStatus(
        `已读取 ${response.count} 首歌曲，正在依次提交下载。`,
        "success"
      );
    }
  );
});

pauseButton.addEventListener("click", async () => {
  if (!activeTabId || !currentJob?.running) {
    return;
  }

  pauseButton.disabled = true;
  const result = await sendBackground({
    type: "SET_JOB_PAUSED",
    tabId: activeTabId,
    paused: !currentJob.paused
  });

  if (!result.ok) {
    setStatus(result.error || "无法修改暂停状态。", "error");
    pauseButton.disabled = false;
    return;
  }

  currentJob = result.job;
  applyJobState(currentJob);
});

initialize().catch((error) => {
  setStatus(error.message || "无法读取任务状态。", "error");
});

async function initialize() {
  const tab = await getActiveMusicTab();
  if (!tab) {
    resetIdleControls();
    return;
  }

  const result = await sendBackground({
    type: "GET_JOB_STATE",
    tabId: tab.id
  });

  if (result.ok && result.job) {
    currentJob = result.job;
    applyJobState(currentJob);
  }
}

async function getActiveMusicTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url?.startsWith("https://music.163.com/")) {
    activeTabId = null;
    return null;
  }

  activeTabId = tab.id;
  return tab;
}

function applyJobState(job) {
  if (!job?.running) {
    resetIdleControls();

    if (job?.finishedAt) {
      const parts = [`任务已完成：成功提交 ${job.submitted ?? 0} 首`];
      if (job.failed) {
        parts.push(`失败 ${job.failed}`);
      }
      if (job.fallback) {
        parts.push(`音质回落 ${job.fallback}`);
      }
      setStatus(parts.join("，"), job.failed ? "error" : "success");
    }
    return;
  }

  startButton.disabled = true;
  startButton.textContent = job.paused ? "任务已暂停" : "任务运行中";
  qualitySelect.value = job.quality || "standard";
  qualitySelect.disabled = true;
  pauseButton.disabled = false;
  pauseButton.textContent = job.paused ? "继续任务" : "暂停任务";

  const progress = `${job.submitted ?? 0}/${job.total ?? 0}`;
  setStatus(
    job.paused ? `任务已暂停，当前 ${progress}。` : `任务运行中，当前 ${progress}。`,
    job.paused ? "" : "success"
  );
}

function resetIdleControls() {
  currentJob = null;
  startButton.disabled = false;
  startButton.textContent = "下载当前歌单";
  pauseButton.disabled = true;
  pauseButton.textContent = "暂停任务";
  qualitySelect.disabled = false;
}

function sendBackground(message) {
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

function setStatus(message, type = "") {
  status.textContent = message;
  status.className = type;
}
