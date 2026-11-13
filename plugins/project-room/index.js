/**
 * dsh-project-room · Host 半
 *
 * 给「项目房间」提供四个通用原语（全部基于 DSH 原生能力 + 一个可配置的目录约定）：
 *   1. board   —— 每个项目一份 Markdown 公共看板（读写、不存在则建）
 *   2. tasks   —— 每个项目一份任务清单 JSON（只读）
 *   3. queue   —— 每个项目一份房间待办 JSON（读写）
 *   4. prompt  —— 把一条消息投递给某个会话（走原生 sessionController.prompt，能唤醒冷会话）
 *
 * 目录约定（不占用任何其它插件的私有结构）：
 *   <root>/projects/<项目名>/{board.md, tasks.json, queue.json}
 * root 默认 `<cwd>/.dsh-room`，可用 config.rootDir 覆盖。
 *
 * 设计取舍：这些文件都刻意用「人也能直接读写」的格式（md / 普通 JSON），
 * 这样即使用户不用本插件，也能用普通编辑器维护房间内容。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

export const name = 'project-room';

const MAX_BODY = 256 * 1024;
const PROJECT_RE = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .\-·]{0,63}$/u;

const BOARD_TEMPLATE = `# {project}

> 项目房间的公共看板。成员把结论、产物路径、待办写在这里；人类也能直接编辑本文件。

## 进行中

## 已完成
`;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** 项目房间根目录（每次请求重新解析，改配置即时生效）。 */
/**
 * 房间数据根目录，来源链：
 *   1. config.rootDir —— 显式配置最优先
 *   2. 工作区里存在 `.hub/projects` 的那个目录下的 `.hub` —— 自动识别
 *      AI-Agent-Hub 结构，这样能与既有的黑板/tasks.json 共用同一份文件
 *      （实测：不这么做，看板永远是空的，因为真实黑板在 <repo>/.hub 而不是 .dsh-room）
 *   3. `<cwd>/.dsh-room` —— 兜底，保持插件自包含
 */
/**
 * 候选房间根目录（按优先级）。
 * 2026-11-09 实测教训：`workspaceRegistry.list()` 会返回**多个**工作区，
 * 之前取第一个命中 `.hub/projects` 的，结果拿到了 `D:\Projects\scifork-bone\.hub`
 * （那份只有 7 个头像、也没有「应用开发」项目）→ 看板空白、头像只剩 7 个。
 * 所以这里返回**全部**候选，由调用方按「哪个 root 里真的有这个项目」来选。
 */
function candidateRoots(config, hub) {
  const roots = [];
  const configured = typeof config?.rootDir === 'string' && config.rootDir.trim();
  if (configured) roots.push(resolve(configured.trim()));
  try {
    const registry = hub && typeof hub.get === 'function' ? hub.get('workspaceRegistry') : null;
    const list = registry && typeof registry.list === 'function' ? registry.list() : [];
    for (const workspace of (list || [])) {
      const path = workspace && workspace.path;
      if (path && existsSync(join(path, '.hub', 'projects'))) roots.push(join(path, '.hub'));
    }
  } catch { /* 拿不到工作区就走兜底 */ }
  roots.push(resolve(process.cwd(), '.dsh-room'));
  return [...new Set(roots)];
}

/** 房间数据根目录（单值版本，用于插件的诊断/落盘文件）。 */
function roomRoot(config, hub) {
  const roots = candidateRoots(config, hub);
  return roots[0] || resolve(process.cwd(), '.dsh-room');
}

function projectDir(config, project, hub) {
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) return null;
  const roots = candidateRoots(config, hub);
  const candidates = roots.map((root) => join(root, 'projects', project)).filter((dir) => existsSync(dir));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 多个工作区都有同名项目（实测：scifork-bone 与 AI-Agent-Hub 都有「应用开发」）：
    // 取 board.md 最新那份——有内容的那个才是当前在用的房间。
    const scored = candidates.map((dir) => {
      const file = join(dir, 'board.md');
      return { dir, mtime: existsSync(file) ? statSync(file).mtimeMs : 0 };
    }).sort((a, b) => b.mtime - a.mtime);
    return scored[0].dir;
  }
  return join(roots[0], 'projects', project);
}

function readTextFile(path, fallback = '') {
  try {
    if (!existsSync(path)) return fallback;
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function readJsonFile(path) {
  const raw = readTextFile(path);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 头像表来源链（第一份能解析的就用）：
 *   1. config.avatarsPath —— 显式指定的 JSON 文件（可指向别的工具维护的头像表）
 *   2. `<root>/avatars.json` —— 插件自己的、用户可维护
 *   3. `<cwd>/.hub/avatars.json` —— 兼容 AI-Agent-Hub 那种现成结构（存在才读）
 * 都没有就返回空对象，客户端退化成「名字首字符 + 稳定色块」。
 * 这样自定义 emoji 是**可选增强**，不构成对任何私有目录的硬依赖。
 */
function loadAvatars(config, hub) {
  const merged = {};
  const paths = [];
  if (typeof config?.avatarsPath === 'string' && config.avatarsPath.trim()) {
    paths.push(resolve(config.avatarsPath.trim()));
  }
  // 每个候选 root 的 avatars.json 都读一遍并合并——多工作区时各自的头像表
  // 往往只覆盖自己那批 agent，合并才完整（实测：只读第一个 root 时只剩 7 条）。
  for (const root of candidateRoots(config, hub)) paths.push(join(root, 'avatars.json'));
  paths.push(join(process.cwd(), '.hub', 'avatars.json'));
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const data = readJsonFile(path);
    if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(merged, data);
  }
  return merged;
}

/**
 * 磁盘上真实存在的会话 id（裸 uuid，小写）。
 * 目录名有两种形态（2026-11-09 实测）：老会话是纯 uuid，新会话是 `session-<uuid>`。
 * 统一剥前缀后按裸 uuid 收录，前端比较时也剥前缀，两边口径一致。
 */
function diskSessionIds() {
  const base = join(homedir(), '.dsh', 'sessions');
  const ids = new Set();
  let workspaces = [];
  try { workspaces = readdirSync(base); } catch { return ids; }
  for (const workspace of workspaces) {
    const dir = join(base, workspace);
    let entries = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch { continue; }
    for (const name of entries) {
      const bare = String(name).replace(/^session-/, '').toLowerCase();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)) ids.add(bare);
    }
  }
  return ids;
}

/** 原子写：先写临时文件再 rename，避免读到半截内容。 */
function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    // 极端情况下 rename 失败（跨盘/被占用）→ 直接覆盖，再清理临时文件
    writeFileSync(path, text, 'utf8');
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (hub) => {
    const server = hub.webServer;

    /** 统一包一层：所有端点共用的错误处理与 CORS-free JSON 响应。 */
    const route = (path, handle) => {
      hub.effect(() => server.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handle(req, res);
          } catch (error) {
            json(res, 500, { ok: false, error: String((error && error.message) || error) });
          }
        },
      }), `dsh-project-room:${path}`);
    };

    // —— 1. 公共看板：GET 读 / POST 建模板（幂等）——
    route('/project-room/board', async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const project = url.searchParams.get('project') || '';
      const dir = projectDir(config, project, hub);
      if (!dir) { json(res, 400, { ok: false, error: '非法项目名' }); return; }

      const file = join(dir, 'board.md');
      if (req.method === 'POST') {
        const payload = await readBody(req);
        // 带 content → 覆盖写；不带 → 只在缺失时建模板（幂等）
        if (typeof payload?.content === 'string') {
          writeFileAtomic(file, payload.content);
          json(res, 200, { ok: true, saved: true, board: payload.content });
          return;
        }
        if (!existsSync(file)) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, BOARD_TEMPLATE.replace('{project}', project), 'utf8');
        }
        json(res, 200, { ok: true, created: true, board: readTextFile(file) });
        return;
      }
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET/POST only' }); return; }
      const exists = existsSync(file);
      json(res, 200, {
        ok: true,
        exists,
        board: exists ? readTextFile(file) : '',
        mtime: exists ? statSync(file).mtimeMs : 0,
      });
    });

    // —— 2. 任务清单：只读 ——
    route('/project-room/tasks', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const project = url.searchParams.get('project') || '';
      const dir = projectDir(config, project, hub);
      if (!dir) { json(res, 400, { ok: false, error: '非法项目名' }); return; }
      json(res, 200, { ok: true, tasks: readJsonFile(join(dir, 'tasks.json')) });
    });

    // —— 2b. 头像表：GET（可选增强，缺文件返回 {}）——
    route('/project-room/avatars', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
      json(res, 200, { ok: true, avatars: loadAvatars(config, hub) });
    });

    // —— 3. 房间待办：GET 读 / POST 覆盖写 ——
    route('/project-room/queue', async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const project = url.searchParams.get('project') || '';
      const dir = projectDir(config, project, hub);
      if (!dir) { json(res, 400, { ok: false, error: '非法项目名' }); return; }
      const file = join(dir, 'queue.json');

      if (req.method === 'POST') {
        const payload = await readBody(req);
        const list = Array.isArray(payload?.list) ? payload.list : null;
        if (!list) { json(res, 400, { ok: false, error: 'list 必须是数组' }); return; }
        writeFileAtomic(file, JSON.stringify({ project, list, updatedAt: Date.now() }, null, 2));
        json(res, 200, { ok: true, count: list.length });
        return;
      }
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET/POST only' }); return; }
      const data = readJsonFile(file);
      json(res, 200, { ok: true, list: Array.isArray(data?.list) ? data.list : [] });
    });

    // —— 4. 投递消息：原生 sessionController.prompt（能唤醒冷会话）——
    route('/project-room/prompt', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
      const payload = await readBody(req);
      const sessionId = String(payload?.sessionId || '').trim();
      const text = String(payload?.text || '');
      if (!sessionId) { json(res, 200, { ok: false, error: '缺少 sessionId' }); return; }
      if (!text.trim()) { json(res, 200, { ok: false, error: '消息为空' }); return; }
      // ⚠️ 必须每次请求时现取：`ctx.inject(['webServer'], …)` 回调触发时 sessionController
      // 往往还没注册，在回调顶部取一次会永远拿到 undefined（表现为「sessionController 不可用」）。
      const controller = hub.get('sessionController');
      if (!controller || typeof controller.prompt !== 'function') {
        json(res, 200, { ok: false, error: 'sessionController 不可用（宿主未注册该服务）' });
        return;
      }
      try {
        await controller.prompt({
          requestId: `project-room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, AbortSignal.timeout(20000));
        json(res, 200, { ok: true, sessionId });
      } catch (error) {
        json(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
    });

    /** 诊断：当前房间根目录是怎么定出来的（看板为空时先查这里）。 */
    route('/project-room/root', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
      const root = roomRoot(config, hub);
      const roots = candidateRoots(config, hub);
      let workspaces = [];
      let registryError = '';
      try {
        const registry = hub.get('workspaceRegistry');
        const list = registry && typeof registry.list === 'function' ? registry.list() : null;
        workspaces = (list || []).map((ws) => ({
          path: ws && ws.path,
          hasHubProjects: ws && ws.path ? existsSync(join(ws.path, '.hub', 'projects')) : false,
        }));
      } catch (error) {
        registryError = String((error && error.message) || error);
      }
      json(res, 200, {
        ok: true,
        roots,
        cwd: process.cwd(),
        configuredRootDir: config?.rootDir || '(未配置)',
        rootExists: existsSync(root),
        registryError,
        workspaces,
      });
    });

    /** 诊断：列出本插件能取到的宿主服务，便于「某服务不可用」时自查。 */
    route('/project-room/services', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
      const names = ['sessionController', 'workspaceRegistry', 'webServer', 'sessions', 'uiWorkspace', 'spawner', 'agents'];
      const found = {};
      for (const name of names) {
        try {
          const svc = hub.get(name);
          found[name] = svc ? (typeof svc) : null;
        } catch (error) {
          found[name] = `throw: ${String((error && error.message) || error).slice(0, 60)}`;
        }
      }
      json(res, 200, { ok: true, found });
    });

    /**
     * 5. 批量归档会话（给侧栏「清理未分组」用）。
     * 走宿主 `workspaceRegistry.archiveSession`——和 AI-Agent-Hub 的 /hub/session-action
     * 归档走同一条通道（实测成功过），比在浏览器里调 Client 服务可靠。
     * 逐条容错：单条失败不影响其余，失败原因原样回传，界面能显示。
     */
    // —— 任务线手动归档/恢复：直接改 tasks.json 里的 status ——
    route('/project-room/task-status', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
      const payload = await readBody(req);
      const project = String(payload?.project || '').trim();
      const taskId = String(payload?.taskId || '').trim();
      const status = String(payload?.status || '').trim();
      if (!PROJECT_RE.test(project)) { json(res, 400, { ok: false, error: '非法项目名' }); return; }
      if (!taskId) { json(res, 400, { ok: false, error: '缺少 taskId' }); return; }
      if (status !== 'active' && status !== 'archived') {
        json(res, 400, { ok: false, error: 'status 只能是 active 或 archived' });
        return;
      }
      const dir = projectDir(config, project, hub);
      const file = join(dir, 'tasks.json');
      const data = readJsonFile(file);
      if (!data || !Array.isArray(data.tasks)) {
        json(res, 404, { ok: false, error: '该项目没有 tasks.json' });
        return;
      }
      const task = data.tasks.find((item) => item && item.id === taskId);
      if (!task) { json(res, 404, { ok: false, error: `任务线不存在：${taskId}` }); return; }
      const before = { status: task.status, goalState: task.goalState };
      task.status = status;
      // 归档时把目标状态一并收尾；恢复时不强行改回，避免覆盖原值
      if (status === 'archived') task.goalState = 'done';
      writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
      json(res, 200, { ok: true, taskId, before, after: { status: task.status, goalState: task.goalState } });
    });

    route('/project-room/archive', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
      const payload = await readBody(req);
      const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds.map((v) => String(v)).filter(Boolean) : [];
      if (!ids.length) { json(res, 400, { ok: false, error: 'sessionIds 必须是非空数组' }); return; }
      const registry = hub.get('workspaceRegistry');
      if (!registry || typeof registry.archiveSession !== 'function') {
        json(res, 200, { ok: false, error: 'workspaceRegistry.archiveSession 不可用' });
        return;
      }
      const archived = [];
      const failed = [];
      for (const raw of ids) {
        // ⚠️ sessionId 格式坑（2026-11-09 实测）：真实持久化目录 ~/.dsh/sessions/<ws>/<uuid>/
        // 用的是**纯 uuid**；带 `session-` 前缀会被 registry 判成
        // "live sessions and session persistence hold no such session"。
        // 前端拿到的 key 可能是带前缀的形态，所以这里两种都试，谁通用谁。
        const variants = [raw];
        const stripped = String(raw).replace(/^session-/, '');
        if (stripped !== raw) variants.push(stripped);
        let ok = false;
        let lastError = '';
        for (const candidate of variants) {
          try {
            await registry.archiveSession(candidate, { stopActivity: false });
            ok = true;
            break;
          } catch (error) {
            lastError = String((error && error.message) || error);
          }
        }
        if (ok) archived.push(raw);
        else failed.push({ id: raw, error: lastError || '未知错误' });
      }
      // 诊断落盘（放在响应**之前**：之前放在 json(res) 之后，一旦写文件抛错就被路由的
      // catch 吞掉，只表现为响应异常，我这边看不到任何证据）。
      let diagPath = '';
      let diagError = '';
      try {
        diagPath = join(roomRoot(config, hub), 'archive-last.json');
        writeFileAtomic(diagPath, JSON.stringify({
          at: new Date().toISOString(),
          received: ids,
          archived,
          failed,
        }, null, 2));
      } catch (error) {
        diagError = String((error && error.message) || error);
      }
      json(res, 200, { ok: true, total: ids.length, archived: archived.length, failed, diagPath, diagError });
    });

    /**
     * 6. 「磁盘上还活着的会话」白名单。
     * 侧栏里有些会话只存在于前端快照（对应磁盘目录早已不存在），归档必然报
     * `no such session`（实测 25/25 全失败）。这类幽灵条目无法归档，只能不显示。
     * 这里直接读 `~/.dsh/sessions/<工作区>/<uuid>/` 目录，返回真实存在的 uuid 集合。
     */
    route('/project-room/alive', async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'GET only' }); return; }
      const ids = diskSessionIds();
      json(res, 200, { ok: true, count: ids.size, ids: [...ids] });
    });

    /**
     * 6b. 删除幽灵会话的 Host 半（2026-11-12 用户令「这些幽灵对话就不能直接删掉吗」）。
     *
     * 客户端「删除」只清 localStorage 是不够的：这些 id 有的还留在 registry 的
     * 归档集合（`global.archivedSessionIds`）里，有的还留着 session_projcache 缓存。
     * 这里把它们一起清掉。**只清磁盘上已不存在的**——服务端自己再核一遍磁盘目录，
     * 有目录的一律进 skipped，真实会话一个都不动。
     *
     * 摘归档记录用 `unarchiveSession`：它只从集合里删条目、**不做会话存在性检查**
     * （dsh-workspace 的文档明说「an entry whose session is gone still resolves」），
     * 正好用来删悬挂条目；pruneArchivedSessions 当年不敢用它是因为删完幽灵会冒出来，
     * 而这里客户端同时记了墓碑（purged 集合），不会再渲染。
     */
    route('/project-room/purge-sessions', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
      const payload = await readBody(req);
      const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds.map((v) => String(v)).filter(Boolean) : [];
      if (!ids.length) { json(res, 400, { ok: false, error: 'sessionIds 必须是非空数组' }); return; }
      const alive = diskSessionIds();
      const registry = hub.get('workspaceRegistry');
      const archives = new Set(
        registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : [],
      );
      const deleted = [];
      const skipped = [];
      const seen = new Set();   // 同一个会话的两种 id 形态（裸 uuid / session-<uuid>）只处理一次
      let archivedRemoved = 0;
      let cacheRemoved = 0;
      for (const raw of ids) {
        const bare = String(raw).toLowerCase().replace(/^session-/, '');
        if (!bare || seen.has(bare)) continue;
        seen.add(bare);
        if (alive.has(bare)) { skipped.push(raw); continue; }   // 磁盘上还有目录 → 不动
        deleted.push(bare);
        // ① 归档记录（两种 id 形态都试：registry 里存的是当时落盘的原始形态）
        const stored = archives.has(bare) ? bare : (archives.has(`session-${bare}`) ? `session-${bare}` : '');
        if (stored && registry && typeof registry.unarchiveSession === 'function') {
          try {
            await registry.unarchiveSession(stored);
            archives.delete(stored);
            archivedRemoved += 1;
          } catch (error) {
            console.warn(`[project-room] unarchive dangling ${stored} failed: ${String((error && error.message) || error)}`);
          }
        }
        // ② 残留标题缓存
        for (const name of [`${bare}.json`, `session-${bare}.json`]) {
          const cachePath = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', name);
          try {
            if (existsSync(cachePath)) { rmSync(cachePath, { force: true }); cacheRemoved += 1; }
          } catch { /* 缓存删不掉不挡删除 */ }
        }
      }
      const at = new Date().toISOString();
      for (const id of deleted) {
        try {
          appendFileSync(join(roomRoot(config, hub), 'deleted-sessions.log'),
            `${at} purged ghost session ${id} (source=settings/hidden-panel)\n`, 'utf8');
        } catch { /* 日志失败不影响删除 */ }
      }
      json(res, 200, { ok: true, deleted, skipped, archivedRemoved, cacheRemoved });
    });

    /** 7. 改会话标题（侧栏右键「改名」/ 双击改名用）。走原生 sessionController.rename。 */
    route('/project-room/rename', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return; }
      const payload = await readBody(req);
      const sessionId = String(payload?.sessionId || '').trim();
      const title = String(payload?.title || '').trim();
      if (!sessionId) { json(res, 200, { ok: false, error: '缺少 sessionId' }); return; }
      if (!title) { json(res, 200, { ok: false, error: '标题不能为空' }); return; }
      const controller = hub.get('sessionController');
      if (!controller || typeof controller.rename !== 'function') {
        json(res, 200, { ok: false, error: 'sessionController.rename 不可用' });
        return;
      }
      // 与归档同理：两种 id 变体都试（活会话用 session-<uuid>，冷会话用裸 uuid）
      const variants = [sessionId];
      const stripped = sessionId.replace(/^session-/, '');
      if (stripped !== sessionId) variants.push(stripped);
      let lastError = '';
      for (const candidate of variants) {
        try {
          const value = await controller.rename({ sessionId: candidate, title });
          json(res, 200, { ok: true, title: (value && value.title) || title });
          return;
        } catch (error) {
          lastError = String((error && error.message) || error);
        }
      }
      json(res, 200, { ok: false, error: lastError || '改名失败' });
    });

    console.log(`[project-room] Host 半已就绪，房间根目录 = ${roomRoot(config, hub)}`);
  });
}
