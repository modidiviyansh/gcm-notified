import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';

export class WahaError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export interface WahaSession {
  name: string;
  status: string;
  me?: { id: string; pushName?: string; messageCapping?: unknown; reachoutTimelock?: unknown } | null;
}

/** Something a number can post into: a WhatsApp group or a channel it administers. */
export interface WaTarget {
  chatId: string; subject: string; participants: number | null;
  announce: boolean; kind: 'group' | 'channel' | 'community'; role: string | null;
  community?: string | null;          // name of the community a group belongs to
}

export interface WahaFile { mimetype: string; filename: string; data: string }

@Injectable()
export class WahaClient {
  private readonly log = new Logger('WAHA');

  private async call<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30_000, raw = false): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(config.wahaUrl + path, {
        method,
        headers: { 'X-Api-Key': config.wahaApiKey, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: raw ? '*/*' : 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let parsed: any = text;
        try { parsed = JSON.parse(text); } catch { /* keep text */ }
        const msg = typeof parsed === 'object' ? parsed?.message || parsed?.error || JSON.stringify(parsed) : text;
        throw new WahaError(`WAHA ${method} ${path} → ${res.status}: ${String(msg).slice(0, 300)}`, res.status, parsed);
      }
      if (raw) return Buffer.from(await res.arrayBuffer()) as unknown as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- sessions ----
  createSession(name: string, metadata: Record<string, string>) {
    return this.call<WahaSession>('POST', '/api/sessions', {
      name,
      start: true,
      config: {
        metadata,
        webhooks: [{
          url: `${config.publicUrl}/api/webhooks/waha`,
          events: ['session.status', 'message', 'message.ack'],
          hmac: { key: config.webhookSecret },
          retries: { policy: 'exponential', delaySeconds: 2, attempts: 8 },
        }],
      },
    });
  }
  /** Re-applies webhook config (e.g. after PUBLIC_URL or secret changes). */
  updateSession(name: string, metadata: Record<string, string>) {
    return this.call('PUT', `/api/sessions/${encodeURIComponent(name)}`, {
      config: {
        metadata,
        webhooks: [{
          url: `${config.publicUrl}/api/webhooks/waha`,
          events: ['session.status', 'message', 'message.ack'],
          hmac: { key: config.webhookSecret },
          retries: { policy: 'exponential', delaySeconds: 2, attempts: 8 },
        }],
      },
    });
  }
  getSession(name: string) { return this.call<WahaSession>('GET', `/api/sessions/${encodeURIComponent(name)}`); }
  listSessions() { return this.call<WahaSession[]>('GET', '/api/sessions?all=true'); }
  start(name: string) { return this.call('POST', `/api/sessions/${encodeURIComponent(name)}/start`); }
  stop(name: string) { return this.call('POST', `/api/sessions/${encodeURIComponent(name)}/stop`); }
  restart(name: string) { return this.call('POST', `/api/sessions/${encodeURIComponent(name)}/restart`); }
  logout(name: string) { return this.call('POST', `/api/sessions/${encodeURIComponent(name)}/logout`); }
  deleteSession(name: string) { return this.call('DELETE', `/api/sessions/${encodeURIComponent(name)}`); }
  qrImage(name: string) { return this.call<Buffer>('GET', `/api/${encodeURIComponent(name)}/auth/qr?format=image`, undefined, 30_000, true); }
  requestCode(name: string, phoneNumber: string) {
    return this.call<{ code: string }>('POST', `/api/${encodeURIComponent(name)}/auth/request-code`, { phoneNumber });
  }

  // ---- contacts ----
  checkExists(session: string, phone: string) {
    return this.call<{ numberExists: boolean; chatId?: string }>('GET', `/api/contacts/check-exists?phone=${phone}&session=${encodeURIComponent(session)}`);
  }
  lidToPhone(session: string, lid: string) {
    return this.call<{ lid: string; pn?: string }>('GET', `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`);
  }

  // ---- groups & channels ----
  /**
   * Full group list in ONE request, without member lists. GOWS fetches every group from WhatsApp on each
   * call (limit/offset don't make it cheaper), so never page and never ask for participants — on numbers
   * that are in hundreds of groups that is what runs WAHA out of memory.
   */
  async listGroups(session: string): Promise<WaTarget[]> {
    const raw = await this.call<any>('GET', `/api/${encodeURIComponent(session)}/groups?exclude=participants`, undefined, 180_000);
    const list: any[] = Array.isArray(raw) ? raw : Object.values(raw ?? {});
    const idOf = (g: any) => String(g?.id?._serialized ?? g?.id ?? g?.JID ?? g?.jid ?? '');
    // Community "parent" groups can't receive messages; posting to the community = its announcement group
    const parents = new Map(list.filter((g) => g?.IsParent ?? g?.isParent).map((g) => [idOf(g), g?.Name ?? g?.subject ?? g?.name ?? null]));
    return list
      .filter((g) => !(g?.IsParent ?? g?.isParent))
      .map((g) => {
        const id = g?.id?._serialized ?? g?.id ?? g?.JID ?? g?.jid;
        const parts = g?.participants ?? g?.Participants;
        const count = g?.ParticipantCount ?? g?.participantsCount ?? g?.size ?? (Array.isArray(parts) ? parts.length : null);
        return {
          chatId: typeof id === 'string' ? id : String(id ?? ''),
          subject: g?.subject ?? g?.Name ?? g?.name ?? '(no name)',
          participants: typeof count === 'number' ? count : null,
          announce: !!(g?.IsAnnounce ?? g?.announce ?? g?.isAnnounce),
          kind: (g?.IsDefaultSubGroup ? 'community' : 'group') as WaTarget['kind'], role: null,
          community: (g?.LinkedParentJID && parents.get(String(g.LinkedParentJID))) || null,
        };
      })
      .filter((g) => g.chatId.endsWith('@g.us'));
  }

  /** This number's role in one group: 'superadmin' | 'admin' | 'participant', or null if not a member. */
  async myRole(session: string, groupId: string): Promise<string | null> {
    const s = await this.getSession(session);
    const me = s.me as any;
    const mine = new Set([me?.id, me?.lid, me?.jid].filter(Boolean).map((x: string) => x.split('@')[0].split(':')[0]));
    const parts = await this.call<any[]>('GET', `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants/v2`, undefined, 60_000);
    const row = (parts ?? []).find((p) => ['id', 'pn', 'lid'].some((k) => p?.[k] && mine.has(String(p[k]).split('@')[0].split(':')[0])));
    return row ? String(row.role ?? 'participant').toLowerCase() : null;
  }

  /** Cheap fallback: groups that appear in the recent chat list (local store, no WhatsApp round-trip). */
  async groupsFromChats(session: string): Promise<WaTarget[]> {
    const chats = await this.chats(session, 1000);
    return chats.filter((c) => c.id.endsWith('@g.us'))
      .map((c) => ({ chatId: c.id, subject: c.name || '(no name)', participants: null, announce: false, kind: 'group' as const, role: null }));
  }

  /** Channels this number owns or administers (the only ones it can post to). */
  async listChannels(session: string): Promise<WaTarget[]> {
    const raw = await this.call<any[]>('GET', `/api/${encodeURIComponent(session)}/channels`, undefined, 60_000);
    return (raw ?? [])
      .filter((c) => ['OWNER', 'ADMIN'].includes(String(c?.role ?? '').toUpperCase()))
      .map((c) => ({
        chatId: String(c.id), subject: c.name || '(no name)', participants: typeof c.subscribersCount === 'number' ? c.subscribersCount : null,
        announce: false, kind: 'channel' as const, role: String(c.role).toUpperCase(),
      }))
      .filter((c) => c.chatId.endsWith('@newsletter'));
  }

  /** Chat list from the local store: ids, names and last-activity timestamps only. */
  async chats(session: string, limit: number, order: 'asc' | 'desc' = 'desc') {
    const raw = await this.call<any[]>('GET',
      `/api/${encodeURIComponent(session)}/chats?limit=${limit}&sortBy=conversationTimestamp&sortOrder=${order}`, undefined, 60_000);
    return (raw ?? []).map((c) => ({
      id: String(c?.id?._serialized ?? c?.id ?? ''), name: (c?.name as string | undefined) ?? null,
      ts: Number(c?.conversationTimestamp ?? c?.timestamp ?? 0) || 0,
    }));
  }

  // ---- sending ----
  startTyping(session: string, chatId: string) { return this.call('POST', '/api/startTyping', { session, chatId }, 10_000); }
  stopTyping(session: string, chatId: string) { return this.call('POST', '/api/stopTyping', { session, chatId }, 10_000); }
  sendText(session: string, chatId: string, text: string) {
    return this.call<{ id?: any; key?: { id: string } }>('POST', '/api/sendText', { session, chatId, text, linkPreview: false }, 60_000);
  }
  sendImage(session: string, chatId: string, file: WahaFile, caption: string) {
    return this.call<{ id?: any; key?: { id: string } }>('POST', '/api/sendImage', { session, chatId, file, caption }, 120_000);
  }
  sendFile(session: string, chatId: string, file: WahaFile, caption: string) {
    return this.call<{ id?: any; key?: { id: string } }>('POST', '/api/sendFile', { session, chatId, file, caption }, 120_000);
  }
}

/** Extracts the message id from the different shapes engines return. */
export function messageIdOf(r: any): string | null {
  const id = r?.id?._serialized ?? r?.id?.id ?? r?.id ?? r?.key?.id ?? r?._data?.id?._serialized ?? null;
  return id ? String(id) : null;
}
