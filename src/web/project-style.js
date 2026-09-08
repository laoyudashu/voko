'use strict';
// Only style the embedded project region. The page shell, typography, colors,
// breadcrumbs and footer come from the existing Local Web UI group renderer.
module.exports = `
#project .task-card{border:1px solid #e1e6ed;border-radius:8px;padding:14px;margin:12px 0}#project .task-card button{margin-right:8px}#project .task-messages{max-height:400px;overflow:auto}#project .description{white-space:pre-wrap;overflow-wrap:anywhere}

:is(#project,#project-settings){font-size:15px}
:is(#project,#project-settings) .icon{width:17px;height:17px;flex-shrink:0;vertical-align:middle}
:is(#project,#project-settings) button{display:inline-flex;align-items:center;justify-content:center;gap:7px;margin:0;min-width:0}
:is(#project,#project-settings) .project-context{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
:is(#project,#project-settings) .project-context h2{font-size:20px;margin:0}
:is(#project,#project-settings) .project-context p{margin:3px 0 0;color:#666;font-size:14px}
:is(#project,#project-settings) .chat-link{font-size:14px;display:flex;align-items:center;gap:7px}
:is(#project,#project-settings) .project-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:2px solid #e0e0e0;margin:16px 0;padding:0}
:is(#project,#project-settings) .project-tabs button{background:transparent;border:0;border-bottom:3px solid transparent;border-radius:0;color:#666;padding:10px 16px;font-size:16px;font-weight:600;margin-bottom:-2px}
:is(#project,#project-settings) .project-tabs button:hover{background:#e8f0fe;color:#1a73e8}
:is(#project,#project-settings) .project-tabs button[aria-current=page]{color:#1a73e8;border-bottom-color:#1a73e8;font-weight:700}
:is(#project,#project-settings) .nav-count{font-size:12px;background:#e8f0fe;border-radius:10px;padding:0 6px;color:#1a73e8}
:is(#project,#project-settings) .page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin:18px 0}
:is(#project,#project-settings) .page-heading h2{font-size:20px;margin:0}
:is(#project,#project-settings) .subtitle{color:#888;font-size:14px;margin:3px 0 0}
:is(#project,#project-settings) .tools{display:flex;gap:8px;align-items:center}
:is(#project,#project-settings) .tools button,:is(#project,#project-settings) .dialog-actions button,:is(#project,#project-settings) .settings-panel>button{font-size:14px;padding:8px 14px}
:is(#project,#project-settings) button:not(.primary):not(.project-tab){background:#fff;color:#1a73e8;border-color:#c7d7f3}
:is(#project,#project-settings) button:not(.primary):not(.project-tab):hover{background:#e8f0fe}
:is(#project,#project-settings) .board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:start}
:is(#project,#project-settings) .column{background:#f0f3f8;border:1px solid #dfe4ea;border-radius:8px;padding:14px;min-width:0;min-height:290px}
:is(#project,#project-settings) .column-header{display:flex;gap:8px;align-items:center;margin-bottom:14px}
:is(#project,#project-settings) .column-header h3{font-size:16px;margin:0}
:is(#project,#project-settings) .count{font-size:13px;color:#888}
:is(#project,#project-settings) .status-dot{width:8px;height:8px;border:2px solid #8c98aa;border-radius:50%}
:is(#project,#project-settings) .doing .status-dot{background:#1a73e8;border-color:#1a73e8}
:is(#project,#project-settings) .done .status-dot{background:#0f9d58;border-color:#0f9d58}
:is(#project,#project-settings) article{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:14px;margin:0 0 12px;box-shadow:0 1px 2px rgba(0,0,0,.04);overflow-wrap:anywhere}
:is(#project,#project-settings) article strong{display:block;font-size:15px;line-height:1.7}
:is(#project,#project-settings) .description{color:#666;font-size:14px;margin:8px 0;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
:is(#project,#project-settings) .card-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:12px;color:#888;margin:14px 0}
:is(#project,#project-settings) .card-meta>span{display:inline-flex;gap:4px;align-items:center}
:is(#project,#project-settings) .avatar{display:inline-grid!important;place-items:center;width:25px;height:25px;border-radius:50%;background:#e8f0fe;color:#1a73e8;flex-shrink:0;font-size:12px}
:is(#project,#project-settings) .card-actions{display:flex;gap:6px;align-items:center;border-top:1px solid #eee;padding-top:10px;flex-wrap:wrap}
:is(#project,#project-settings) .card-actions button{font-size:13px;padding:3px 6px;border:0}
:is(#project,#project-settings) .card-actions label{font-size:0;margin:0 auto 0 0}
:is(#project,#project-settings) .card-actions select{font-size:13px;width:auto;max-width:100%;border:1px solid #c7d7f3;padding:4px;margin:0;color:#1a73e8}
:is(#project,#project-settings) .empty-column{border:1px dashed #ccd5e3;border-radius:6px;height:200px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#888;font-size:14px}
:is(#project,#project-settings) .empty-column p{margin:0}
:is(#project,#project-settings) .empty-column .icon{width:24px;height:24px;color:#a6b4c8}
:is(#project,#project-settings) .empty-state{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:40px 24px;text-align:center;display:flex;align-items:center;flex-direction:column;gap:14px}
:is(#project,#project-settings) .empty-state>.icon{width:32px;height:32px;color:#1a73e8}
:is(#project,#project-settings) .empty-state h3{margin:0}
:is(#project,#project-settings) .empty-state p{max-width:520px;color:#666;margin:0;font-size:14px}
:is(#project,#project-settings) .settings-panel{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:20px}
:is(#project,#project-settings) .settings-panel label{margin:0 0 20px}
:is(#project,#project-settings) .settings-panel textarea{display:block;width:100%;max-width:720px;min-height:100px}
:is(#project,#project-settings) .settings-panel select{display:block}
:is(#project,#project-settings) dialog{width:540px;max-width:calc(100vw - 32px);border:0;border-radius:12px;padding:24px;background:#fff;color:#1a1a2e;box-shadow:0 18px 60px rgba(21,31,46,.28)}
:is(#project,#project-settings) dialog::backdrop{background:rgba(24,34,48,.48);backdrop-filter:blur(2px)}
:is(#project,#project-settings) dialog h2{margin:0 0 16px}
:is(#project,#project-settings) dialog input,:is(#project,#project-settings) dialog textarea,:is(#project,#project-settings) dialog select{width:100%;max-width:none}
:is(#project,#project-settings) dialog textarea{min-height:100px}
:is(#project,#project-settings) .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
:is(#project,#project-settings) .dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0}
:is(#project,#project-settings) .member-list,:is(#project,#project-settings) .timeline{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:0 18px}
:is(#project,#project-settings) .member-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #eee;font-size:14px}
:is(#project,#project-settings) .member-row:last-child,:is(#project,#project-settings) .event:last-child{border:0}
:is(#project,#project-settings) .member-row .badge{margin-left:auto;color:#1a73e8;background:#e8f0fe;border-color:#c7d7f3}
:is(#project,#project-settings) .event{display:flex;gap:12px;padding:16px 0;border-bottom:1px solid #eee}
:is(#project,#project-settings) .event small{display:block;color:#888;font-size:13px}
:is(#project,#project-settings) .event .dot{margin-top:10px;background:#1a73e8;width:6px;height:6px;border-radius:50%}
#project-alert:empty{display:none}
:is(#project,#project-settings) .storage-summary{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;background:#fff;border:1px solid #e0e0e0;padding:20px;border-radius:8px;margin-bottom:18px}
:is(#project,#project-settings) .storage-summary h3{margin:0}
:is(#project,#project-settings) .storage-summary button{font-size:14px;padding:8px 14px}
:is(#project,#project-settings) .storage-status{display:inline-block;font-size:12px;margin-top:10px;color:#666;background:#f0f3f8;border-radius:4px;padding:2px 8px}
:is(#project,#project-settings) .storage-form{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:24px;max-width:760px}
:is(#project,#project-settings) .storage-form label{margin-top:18px}
:is(#project,#project-settings) .storage-form input,:is(#project,#project-settings) .storage-form select{display:block;max-width:none;width:100%}
:is(#project,#project-settings) .storage-form input[readonly]{background:#f5f7fa;color:#777;font-size:14px}
:is(#project,#project-settings) .storage-form small{display:block;color:#888;font-size:12px;margin-top:6px}
:is(#project,#project-settings) .storage-form .subtitle{margin-top:12px}
:is(#project,#project-settings) .storage-feedback{font-size:14px;color:#b3261e}
#project-alert:not(:empty){padding:10px 14px;border:1px solid #f0d5d2;background:#fff8f7;color:#b3261e;border-radius:6px;white-space:pre-wrap}
@media(max-width:760px){:is(#project,#project-settings) .board{grid-template-columns:1fr}:is(#project,#project-settings) .column{min-height:220px}:is(#project,#project-settings) .empty-column{height:150px}:is(#project,#project-settings) .project-tabs button{font-size:14px;padding:8px 10px}:is(#project,#project-settings) .form-row{grid-template-columns:1fr;gap:0}}
`;
