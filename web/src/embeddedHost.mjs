function frameCapability() {
  return typeof globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ === "string"
    ? globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__
    : "";
}

let activeFrameChallenge = "";

export function setEmbeddedFrameChallenge(challenge) {
  activeFrameChallenge = typeof challenge === "string" ? challenge : "";
}

export function postEmbeddedHostMessage(message) {
  window.parent.postMessage({
    ...message,
    capability: frameCapability(),
    challenge: activeFrameChallenge,
  }, "*");
}

export function createNativeProject(name) {
  if (window.parent === window) return Promise.reject(new Error("请在 Codex 侧边栏中创建项目 / Open Dashboard in the Codex sidebar"));
  const requestId = window.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, project) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (error) reject(new Error(error));
      else resolve(project);
    };
    const receive = event => {
      if (event.source !== window.parent || event.data?.type !== "taskboard:project-created" || event.data.payload?.requestId !== requestId) return;
      const { project, error } = event.data.payload;
      if (error) finish(error);
      else if (project?.id && project?.name && project?.workspacePath) finish(null, project);
      else finish("Codex did not return a project");
    };
    const timer = window.setTimeout(() => finish("Codex 项目创建尚未确认，请先检查侧边栏，勿重复创建 / Check the Codex sidebar before retrying"), 120_000);
    window.addEventListener("message", receive);
    postEmbeddedHostMessage({ type: "taskboard:create-project", payload: { requestId, name } });
  });
}

export function installEmbeddedExternalLinkHandler() {
  const handleClick = (event) => {
    const link = event.target instanceof Element
      ? event.target.closest('a[target="_blank"]')
      : null;
    if (!link) return;

    const rawHref = link.getAttribute("href");
    if (!rawHref) return;

    let url;
    try {
      url = new URL(rawHref);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    postEmbeddedHostMessage({
      type: "taskboard:open-external",
      payload: { url: url.href },
    });
  };

  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
}
