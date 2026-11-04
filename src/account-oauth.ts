import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { getGoogleClientId, getGoogleClientSecret } from './accounts.js';

type LoginPhase = 'waiting' | 'exchanging' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
type Tokens = { access_token: string; refresh_token: string; expires_in?: number; id_token?: string };
type Session = { id: string; phase: LoginPhase; state: string; verifier: string; redirect: string; url: string; server: Server; controller: AbortController; timer: NodeJS.Timeout; message: string; expiresAt: number; work?: Promise<void> };
export class GoogleAccountLogin {
  private sessions = new Map<string, Session>();
  constructor(private readonly save: (token: Tokens, signal: AbortSignal) => Promise<void>, private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly timeoutMs = 600_000) {}
  async begin(): Promise<{ id: string; url: string }> {
    const clientId = getGoogleClientId(), clientSecret = getGoogleClientSecret();
    if (!clientId || !clientSecret) throw new Error('未配置 Google OAuth 凭据，请在 .env 中配置 GRAVITYBOX_GOOGLE_CLIENT_ID 与 GRAVITYBOX_GOOGLE_CLIENT_SECRET');
    for (const s of this.sessions.values()) {
      if (s.phase === 'saving') throw new Error('账号正在保存，请稍候');
      this.cancel(s.id);
    }
    while (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value!);
    const server = createServer(); server.maxHeadersCount = 30; server.headersTimeout = 5000; server.requestTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('无法创建本机授权回调'); }
    const redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent select_account', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: ['openid','https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/cclog','https://www.googleapis.com/auth/experimentsandconfigs'].join(' ') }).toString();
    const s: Session = { id: randomUUID(), phase: 'waiting', state, verifier, redirect, url: url.href, server, controller: new AbortController(), timer: undefined!, message: '', expiresAt: Date.now() + this.timeoutMs };
    s.timer = setTimeout(() => { if (s.phase !== 'saving') this.finish(s, 'expired', '授权已超时，请重新登录'); }, this.timeoutMs); s.timer.unref();
    this.sessions.set(s.id, s);
    server.on('error', () => this.finish(s, 'failed', '本机授权回调不可用，请重试'));
    server.on('request', (req, res) => {
      const respond = (code: number, message: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close' }); res.end(`<!doctype html><meta charset="utf-8"><title>GravityBox</title><p>${message}</p>`); };
      let callback: URL;
      try { callback = new URL(req.url || '', redirect); } catch { respond(400, '无效请求'); return; }
      if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || callback.pathname !== '/oauth/callback') { respond(404, '未找到'); return; }
      const returnedState = Buffer.from(callback.searchParams.get('state') || ''); const expected = Buffer.from(s.state);
      if (returnedState.length !== expected.length || !timingSafeEqual(returnedState, expected)) { respond(400, '授权校验失败，请返回 GravityBox'); return; }
      if (s.phase !== 'waiting') { respond(409, '此授权已处理，请返回 GravityBox'); return; }
      if (callback.searchParams.has('error')) { respond(200, '已取消授权，可关闭此页面'); this.finish(s, 'cancelled', '已取消 Google 授权'); return; }
      const code = callback.searchParams.get('code');
      if (!code || code.length > 8192) { respond(400, '授权响应不完整'); return; }
      s.phase = 'exchanging'; respond(200, '正在完成授权，请返回 GravityBox 查看结果');
      s.work = this.exchange(s, code);
    });
    return { id: s.id, url: s.url };
  }
  status(id: string) {
    const s = this.sessions.get(id); if (!s) throw new Error('授权已过期，请重新登录');
    return { id: s.id, phase: s.phase, message: s.message, expiresAt: s.expiresAt };
  }
  cancel(id: string) {
    const s = this.sessions.get(id);
    if (s && ['waiting','exchanging'].includes(s.phase)) this.finish(s, 'cancelled', '已取消 Google 授权');
    return this.status(id);
  }
  private finish(s: Session, phase: LoginPhase, message: string) {
    clearTimeout(s.timer); s.phase = phase; s.message = message;
    s.controller.abort(); s.server.close(); s.server.closeIdleConnections(); s.state = ''; s.verifier = ''; s.url = '';
  }
  private async exchange(s: Session, code: string) {
    try {
      const reply = await this.fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.any([s.controller.signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: getGoogleClientId(), client_secret: getGoogleClientSecret(), code, code_verifier: s.verifier, redirect_uri: s.redirect, grant_type: 'authorization_code' }).toString() });
      if (!reply.ok) throw new Error('Google 授权未完成，请重新登录');
      const token = await reply.json() as Tokens;
      if (!token.access_token || !token.refresh_token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') throw new Error('未取得可保存的登录凭据，请重新授权');
      s.controller.signal.throwIfAborted();
      s.phase = 'saving'; clearTimeout(s.timer);
      await this.save(token, s.controller.signal);
      this.finish(s, 'succeeded', '账号已保存');
    } catch (error) {
      if (s.controller.signal.aborted) return;
      this.finish(s, 'failed', error instanceof Error && /^(Google|未取得|未能|账号)/.test(error.message) ? error.message : '无法完成 Google 登录，请检查网络后重试');
    }
  }
  async close() {
    for (const s of this.sessions.values()) if (!['succeeded','failed','cancelled','expired'].includes(s.phase)) this.finish(s, 'cancelled', '授权已结束');
    await Promise.allSettled([...this.sessions.values()].map(s => s.work).filter((p): p is Promise<void> => !!p));
  }
}
