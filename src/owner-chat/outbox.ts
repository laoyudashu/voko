import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

class OwnerChatOutbox {
  private timer: NodeJS.Timeout|null = null; private running = false;
  constructor(private readonly db: DatabaseSync, private readonly deliver: any, private readonly intervalMs = 2000) {}
  start(): () => void { if (!this.timer) { this.timer=setInterval(()=>void this.flush(),this.intervalMs); this.timer.unref?.(); void this.flush(); } return ()=>this.stop(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer=null; }
  async flush(): Promise<number> {
    if (this.running) return 0; this.running=true; let sent=0; const lease=`owner-chat-out-${crypto.randomUUID()}`; const now=Date.now();
    try {
      const rows=this.db.prepare(`SELECT * FROM owner_chat_outbox WHERE status='pending' AND (lease_expires_at IS NULL OR lease_expires_at<?) ORDER BY created_at LIMIT 20`).all(now) as any[];
      for (const row of rows) {
        const claim=this.db.prepare("UPDATE owner_chat_outbox SET status='leased',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE event_id=? AND status='pending'").run(lease,now+30000,now,row.event_id) as any;
        if (Number(claim.changes||0)!==1) continue;
        try {
          const result=await this.deliver.deliver(row.local_agent_id,row.owner_im_uid,row.payload_json,'text',1,null,row.event_id);
          if (result?.success) { this.db.prepare("UPDATE owner_chat_outbox SET status='sent',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE event_id=? AND lease_owner=?").run(Date.now(),row.event_id,lease); sent++; }
          else this.db.prepare("UPDATE owner_chat_outbox SET status=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE event_id=? AND lease_owner=?").run(result?.outcomeUnknown?'outcome_unknown':'pending',Date.now(),row.event_id,lease);
        } catch (error: any) { this.db.prepare("UPDATE owner_chat_outbox SET status=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE event_id=? AND lease_owner=?").run(error?.outcomeUnknown?'outcome_unknown':'pending',Date.now(),row.event_id,lease); }
      }
      return sent;
    } finally { this.running=false; }
  }
}

export { OwnerChatOutbox };
