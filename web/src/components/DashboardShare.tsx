import { useState } from "react";
import { dashboardShare } from "../api";

export function DashboardShare() {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<{ url: string | null; localOnly: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(method: "GET" | "POST" | "DELETE") {
    setBusy(true); setError("");
    try { setShare(await dashboardShare(method)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="button secondary" onClick={() => { setOpen(true); void load("GET"); }}>分享</button>
    {open && <div className="delete-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <section className="delete-dialog project-share-dialog" role="dialog" aria-modal="true" aria-labelledby="project-share-title">
        <h2 id="project-share-title">分享 Dashboard</h2>
        <p>公开所有项目的看板，包括项目名称、状态、任务标题和描述。持有链接的人可查看；不能打开任务详情、对话、评论或附件，也不能编辑。</p>
        {share?.localOnly && <p>当前仅可本机预览。尚未配置同事可访问的分享地址。</p>}
        {share?.url && <>
          <input readOnly aria-label="分享链接" value={share.url} onFocus={event => event.target.select()} />
          <a href={share.url} target="_blank" rel="noreferrer">预览只读页面</a>
        </>}
        {error && <p role="alert" className="project-dialog-error">{error}</p>}
        <div className="project-share-actions">
          {!share?.url && <button className="button primary" disabled={busy || !share} onClick={() => void load("POST")}>启用分享</button>}
          {share?.url && <>
            <button className="button primary" disabled={busy || share.localOnly} onClick={() => { void navigator.clipboard.writeText(share.url!).then(() => setError("链接已复制"), () => setError("复制失败，请选中链接手动复制")); }}>复制分享链接</button>
            <button className="button secondary" disabled={busy} onClick={() => void load("DELETE")}>撤销分享</button>
          </>}
          <button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>关闭</button>
        </div>
      </section>
    </div>}
  </>;
}
