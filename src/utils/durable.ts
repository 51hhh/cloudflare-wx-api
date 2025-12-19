import { DurableObject } from "cloudflare:workers";
import { Utils } from "./utils";
import { ChatMessage, SseMessage, LogEntry, LogFilter, LogStats, ConversationMessage, ConversationSummary, UserInfo, UserFilter, AuthLogEntry, AuthFilter, LogType, SessionLog, PipelineStep } from "./shard.d";

export class Durable extends DurableObject {
  #ChatHistory: Map<string, ChatMessage[]>;
  #Clients: Map<string, any>;  // {ticket: writer}
  #LoggerClients: Map<string, WritableStreamDefaultWriter<Uint8Array>>; // WebSocket clients for real-time logs
  #CodeUidMap: Map<string, string>;
  #UidCodeMap: Map<string, string>;
  #Expire: number;
  #MaxTimes: number;
  #AllowOrigin: string;
  #TicketPrefix: string;
  #TicketSize: number;
  #SystemTip: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ChatHistory = new Map();
    this.#Clients = new Map();
    this.#LoggerClients = new Map();
    this.#CodeUidMap = new Map();
    this.#UidCodeMap = new Map();
    this.#Expire = env.AuthExpireSecs * 1000;
    this.#MaxTimes = Math.floor(env.AuthExpireSecs / 3);
    this.#AllowOrigin = env.AllowOrigin;
    this.#TicketPrefix = env.TicketPrefix;
    this.#TicketSize = env.TicketSize;
    this.#SystemTip = env.LLMSystemTip;
    
    // 初始化原有messages表
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS `messages` (`uid` CHAR(28), `role` VCHAR(9), `content` TEXT);",
    );
    
    // 初始化日志表
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS \`logs\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`timestamp\` INTEGER NOT NULL,
        \`type\` VARCHAR(20) NOT NULL,
        \`uid\` VARCHAR(64),
        \`method\` VARCHAR(10),
        \`path\` VARCHAR(255),
        \`status\` INTEGER,
        \`duration\` INTEGER,
        \`ip\` VARCHAR(45),
        \`user_agent\` VARCHAR(512),
        \`request_body\` TEXT,
        \`response_body\` TEXT,
        \`extra\` TEXT
      );
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_logs_timestamp` ON `logs` (`timestamp` DESC);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_logs_type` ON `logs` (`type`);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_logs_uid` ON `logs` (`uid`);");
    
    // 初始化会话记录表
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS \`conversations\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`uid\` VARCHAR(64) NOT NULL,
        \`timestamp\` INTEGER NOT NULL,
        \`role\` VARCHAR(10) NOT NULL,
        \`content\` TEXT NOT NULL,
        \`msg_type\` VARCHAR(20),
        \`tokens\` INTEGER,
        \`duration\` INTEGER,
        \`log_id\` INTEGER
      );
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_conv_uid` ON `conversations` (`uid`);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_conv_timestamp` ON `conversations` (`timestamp` DESC);");
    
    // 初始化用户表
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS \`users\` (
        \`uid\` VARCHAR(64) PRIMARY KEY,
        \`first_seen\` INTEGER NOT NULL,
        \`last_seen\` INTEGER NOT NULL,
        \`nickname\` VARCHAR(64),
        \`msg_count\` INTEGER DEFAULT 0,
        \`llm_tokens\` INTEGER DEFAULT 0,
        \`auth_count\` INTEGER DEFAULT 0,
        \`last_auth\` INTEGER,
        \`status\` VARCHAR(10) DEFAULT 'active',
        \`extra\` TEXT
      );
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_users_last_seen` ON `users` (`last_seen` DESC);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_users_status` ON `users` (`status`);");
    
    // 初始化认证记录表
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS \`auth_logs\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`uid\` VARCHAR(64) NOT NULL,
        \`timestamp\` INTEGER NOT NULL,
        \`auth_type\` VARCHAR(20) NOT NULL,
        \`ticket\` VARCHAR(128),
        \`success\` INTEGER NOT NULL,
        \`ip\` VARCHAR(45),
        \`user_agent\` VARCHAR(512),
        \`extra\` TEXT
      );
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_auth_uid` ON `auth_logs` (`uid`);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_auth_timestamp` ON `auth_logs` (`timestamp` DESC);");

    // 初始化聚合会话日志表
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS \`session_logs\` (
        \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
        \`session_id\` VARCHAR(32) NOT NULL,
        \`timestamp\` INTEGER NOT NULL,
        \`uid\` VARCHAR(64) NOT NULL,
        \`msg_type\` VARCHAR(20) NOT NULL,
        \`input_content\` TEXT,
        \`output_content\` TEXT,
        \`total_duration\` INTEGER,
        \`steps\` TEXT,
        \`ip\` VARCHAR(45),
        \`user_agent\` VARCHAR(512),
        \`method\` VARCHAR(10),
        \`path\` VARCHAR(255),
        \`status\` INTEGER NOT NULL,
        \`extra\` TEXT
      );
    `);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_session_timestamp` ON `session_logs` (`timestamp` DESC);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_session_uid` ON `session_logs` (`uid`);");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS `idx_session_msg_type` ON `session_logs` (`msg_type`);");

    const cursor = ctx.storage.sql.exec("SELECT * FROM `messages`;");
    for (const row of cursor) {
      const uid = row.uid as string;
      const role = row.role as "system" | "user" | "assistant";
      const content = row.content as string;
      if (!this.#ChatHistory.has(uid)) {
        this.#ChatHistory.set(uid, []);
      }
      this.#ChatHistory.get(uid)!.push({ role, content });
    }
  }

  #expireAuthCode(code: string, uid: string): void {
    setTimeout(() => {
      this.#CodeUidMap.delete(code);
      this.#UidCodeMap.delete(uid);
    }, this.#Expire);
  }

  handleGetCodeByUid(uid: string): string {
    let code = this.#UidCodeMap.get(uid);
    if (code !== undefined) return code;

    code = Utils.random_string(6, "1234566678888999");
    while (this.#CodeUidMap.has(code)) code = Utils.random_string(6, "1234566678888999");
    this.#CodeUidMap.set(code, uid);
    this.#UidCodeMap.set(uid, code);
    this.#expireAuthCode(code, uid);
    return code;
  }

  handleGetUidByCode(code: string): string | undefined {
    const uid = this.#CodeUidMap.get(code);
    if (uid === undefined) return undefined;
    this.#CodeUidMap.delete(code);
    this.#UidCodeMap.delete(uid);
    return uid;
  }

  async #writeSafe(ticket: string, data: SseMessage, callClose: boolean = true): Promise<boolean> {
    const writer = this.#Clients.get(ticket);
    if (!writer) {
      return false;
    }

    try {
      const message = `event: SSE\ndata: ${JSON.stringify(data)}\n\n`;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Write timeout")), 500)
      );

      await Promise.race([
        writer.write(new TextEncoder().encode(message)),
        timeoutPromise
      ]);

      return true;
    } catch (err: any) {
      callClose && this.#closeConnection(ticket, `Write to ${ticket} failed: ${err.message}`);
      return false;
    }
  }

  #setupHeartbeat(ticket: string): void {
    let count = 0;

    const next = async () => {
      try {
        count++;
        const success = await this.#writeSafe(ticket, { code: 300, data: count });
        if (!success) {
          throw new Error("Heartbeat write failed");
        }

        if (count >= this.#MaxTimes) {
          await this.#writeSafe(ticket, { code: 400, data: "timeout" });
          this.#closeConnection(ticket, null, true);
          return;
        }

        setTimeout(next, 3000);
      } catch (err: any) {
        this.#closeConnection(ticket, `Heartbeat error: ${err.message}`);
      }
    };

    setTimeout(next, 3000);
  }

  async #closeConnection(ticket: string, msg: string | null, close: boolean = false): Promise<void> {
    const writer = this.#Clients.get(ticket);
    if (!writer) return;
    msg && console.log(msg);
    close && await this.#writeSafe(ticket, { code: -1, data: "connection closed" }, false);

    try {
      const closePromise = writer.close();
      const timeout = new Promise(resolve => setTimeout(resolve, 200));
      await Promise.race([closePromise, timeout]);
    } catch (err: any) {
      console.log(`Error closing writer for ${ticket}: ${err.message}`);
    } finally {
      this.#Clients.delete(ticket);
    }
  }

  async handleAcceptSSE(request: Request): Promise<Response> {
    const ticket = Utils.random_string(this.#TicketSize);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    request.signal.addEventListener("abort", () => {
      this.#closeConnection(ticket, `Connection ${ticket} aborted by client`);
    });
    writer.closed.catch((err) => {
      this.#closeConnection(ticket, `Writer closed for ${ticket}: ${err.message}`);
    });

    this.#Clients.set(ticket, writer);
    this.#setupHeartbeat(ticket);
    setTimeout(async () => await this.#writeSafe(ticket, { code: 100, data: this.#TicketPrefix + ticket }), 0);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": this.#AllowOrigin
      }
    });
  }

  async handleQrcodeLogin(ticket: string, uid: string): Promise<string> {
    if (!this.#Clients.has(ticket)) return "二维码已过期，请刷新页面后再试试吧 ~";
    try {
      await this.#writeSafe(ticket, { code: 200, data: uid });
      this.#closeConnection(ticket, null, true);
      return `登录成功！\n${uid}`;
    } catch (err: any) {
      return `登录失败：\n${err.message}`;
    }
  }

  handleUpdateChatHistory(uid: string, msg: ChatMessage): ChatMessage[] {
    let history = this.#ChatHistory.get(uid);
    if (!history) history = [{ role: "system", content: this.#SystemTip }];
    history.push(msg);
    this.#ChatHistory.set(uid, history);
    this.ctx.storage.sql.exec(
      `INSERT INTO \`messages\` (\`uid\`, \`role\`, \`content\`) VALUES (?, ?, ?);`, uid, msg.role, msg.content
    )
    return history;
  }

  handleGetLastChatContent(uid: string): string {
    let history = this.#ChatHistory.get(uid);
    if (!history) {
      return "== 查无此话 ==";
    }
    for (let i = history.length - 1; i >= 0; --i) {
      if (history[i].role === "assistant") return history[i].content;
    }
    return "== 查无此话 2.0 ==";
  }

  handleClearChatHistory(uid: string): string {
    this.ctx.storage.sql.exec(`DELETE FROM \`messages\` WHERE \`uid\`='${uid}';`);
    if (!this.#ChatHistory.has(uid)) {
      return "【我已经不记得前世啦】";
    }
    this.#ChatHistory.delete(uid);
    return "对话历史已清空，咱重新开始吧~";
  }

  // ============== 日志管理方法 ==============

  // 插入日志
  async handleLogInsert(entry: LogEntry): Promise<number> {
    const result = this.ctx.storage.sql.exec(`
      INSERT INTO \`logs\` (\`timestamp\`, \`type\`, \`uid\`, \`method\`, \`path\`, \`status\`, \`duration\`, \`ip\`, \`user_agent\`, \`request_body\`, \`response_body\`, \`extra\`)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING \`id\`;
    `, entry.timestamp, entry.type, entry.uid || null, entry.method || null, entry.path || null, 
       entry.status || null, entry.duration || null, entry.ip || null, entry.userAgent || null,
       entry.requestBody || null, entry.responseBody || null, entry.extra || null);
    
    const id = result.one().id as number;
    entry.id = id;
    
    // 广播给所有日志监听客户端
    this.#broadcastLog(entry);
    
    // 更新用户信息
    if (entry.uid) {
      await this.handleUserTouch(entry.uid);
    }
    
    return id;
  }

  // 广播日志给实时监听客户端
  #broadcastLog(entry: LogEntry): void {
    const message = JSON.stringify({ type: "log", data: entry });
    const encoded = new TextEncoder().encode(`data: ${message}\n\n`);
    
    for (const [clientId, writer] of this.#LoggerClients) {
      writer.write(encoded).catch(() => {
        this.#LoggerClients.delete(clientId);
      });
    }
  }

  // 查询日志列表
  handleLogQuery(filter: LogFilter): LogEntry[] {
    let sql = "SELECT * FROM `logs` WHERE 1=1";
    const params: any[] = [];
    
    if (filter.type) {
      sql += " AND `type` = ?";
      params.push(filter.type);
    }
    if (filter.uid) {
      sql += " AND `uid` = ?";
      params.push(filter.uid);
    }
    if (filter.startTime) {
      sql += " AND `timestamp` >= ?";
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      sql += " AND `timestamp` <= ?";
      params.push(filter.endTime);
    }
    
    sql += " ORDER BY `timestamp` DESC";
    
    if (filter.limit) {
      sql += ` LIMIT ${filter.limit}`;
    } else {
      sql += " LIMIT 100";
    }
    if (filter.offset) {
      sql += ` OFFSET ${filter.offset}`;
    }
    
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const logs: LogEntry[] = [];
    for (const row of cursor) {
      logs.push({
        id: row.id as number,
        timestamp: row.timestamp as number,
        type: row.type as LogType,
        uid: row.uid as string | undefined,
        method: row.method as string | undefined,
        path: row.path as string | undefined,
        status: row.status as number | undefined,
        duration: row.duration as number | undefined,
        ip: row.ip as string | undefined,
        userAgent: row.user_agent as string | undefined,
        requestBody: row.request_body as string | undefined,
        responseBody: row.response_body as string | undefined,
        extra: row.extra as string | undefined
      });
    }
    return logs;
  }

  // 获取单条日志详情
  handleLogDetail(id: number): LogEntry | null {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM `logs` WHERE `id` = ?;", id).toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id as number,
      timestamp: row.timestamp as number,
      type: row.type as LogType,
      uid: row.uid as string | undefined,
      method: row.method as string | undefined,
      path: row.path as string | undefined,
      status: row.status as number | undefined,
      duration: row.duration as number | undefined,
      ip: row.ip as string | undefined,
      userAgent: row.user_agent as string | undefined,
      requestBody: row.request_body as string | undefined,
      responseBody: row.response_body as string | undefined,
      extra: row.extra as string | undefined
    };
  }

  // 获取统计信息
  handleLogStats(): LogStats {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    
    const totalRequests = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `logs`;").one().cnt as number;
    const todayRequests = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `logs` WHERE `timestamp` >= ?;", todayStart).one().cnt as number;
    const totalUsers = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `users`;").one().cnt as number;
    const activeUsers = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `users` WHERE `last_seen` >= ?;", now - 24 * 60 * 60 * 1000).one().cnt as number;
    const totalLLMCalls = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `logs` WHERE `type` = 'llm_call';").one().cnt as number;
    const todayLLMCalls = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `logs` WHERE `type` = 'llm_call' AND `timestamp` >= ?;", todayStart).one().cnt as number;
    const totalAuthCount = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `auth_logs`;").one().cnt as number;
    const todayAuthCount = this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM `auth_logs` WHERE `timestamp` >= ?;", todayStart).one().cnt as number;
    
    return {
      totalRequests,
      todayRequests,
      totalUsers,
      activeUsers,
      totalLLMCalls,
      todayLLMCalls,
      totalAuthCount,
      todayAuthCount
    };
  }

  // ============== 会话管理方法 ==============

  // 插入会话消息
  handleConversationInsert(msg: ConversationMessage): number {
    const result = this.ctx.storage.sql.exec(`
      INSERT INTO \`conversations\` (\`uid\`, \`timestamp\`, \`role\`, \`content\`, \`msg_type\`, \`tokens\`, \`duration\`, \`log_id\`)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING \`id\`;
    `, msg.uid, msg.timestamp, msg.role, msg.content, msg.msgType || null, msg.tokens || null, msg.duration || null, msg.logId || null);
    
    return result.one().id as number;
  }

  // 获取会话列表(按用户分组)
  handleConversationList(): ConversationSummary[] {
    const cursor = this.ctx.storage.sql.exec(`
      SELECT \`uid\`, COUNT(*) as msg_count, MAX(\`timestamp\`) as last_time
      FROM \`conversations\`
      GROUP BY \`uid\`
      ORDER BY last_time DESC
      LIMIT 100;
    `);
    
    const summaries: ConversationSummary[] = [];
    for (const row of cursor) {
      const uid = row.uid as string;
      // 获取最后一条消息
      const lastMsgRows = this.ctx.storage.sql.exec(
        "SELECT `content` FROM `conversations` WHERE `uid` = ? ORDER BY `timestamp` DESC LIMIT 1;",
        uid
      ).toArray();
      const lastMsg = lastMsgRows.length > 0 ? lastMsgRows[0] : null;
      
      summaries.push({
        uid,
        msgCount: row.msg_count as number,
        lastMessage: lastMsg ? (lastMsg.content as string).substring(0, 50) : "",
        lastTime: row.last_time as number
      });
    }
    return summaries;
  }

  // 获取指定用户的对话详情
  handleConversationDetail(uid: string, limit: number = 100): ConversationMessage[] {
    const cursor = this.ctx.storage.sql.exec(`
      SELECT * FROM \`conversations\`
      WHERE \`uid\` = ?
      ORDER BY \`timestamp\` ASC
      LIMIT ?;
    `, uid, limit);
    
    const messages: ConversationMessage[] = [];
    for (const row of cursor) {
      messages.push({
        id: row.id as number,
        uid: row.uid as string,
        timestamp: row.timestamp as number,
        role: row.role as "user" | "assistant",
        content: row.content as string,
        msgType: row.msg_type as string | undefined,
        tokens: row.tokens as number | undefined,
        duration: row.duration as number | undefined,
        logId: row.log_id as number | undefined
      });
    }
    return messages;
  }

  // ============== 用户管理方法 ==============

  // 更新用户活跃时间(如不存在则创建)
  async handleUserTouch(uid: string): Promise<void> {
    const now = Date.now();
    const existingRows = this.ctx.storage.sql.exec("SELECT * FROM `users` WHERE `uid` = ?;", uid).toArray();
    const existing = existingRows.length > 0 ? existingRows[0] : null;
    
    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE `users` SET `last_seen` = ?, `msg_count` = `msg_count` + 1 WHERE `uid` = ?;",
        now, uid
      );
    } else {
      this.ctx.storage.sql.exec(`
        INSERT INTO \`users\` (\`uid\`, \`first_seen\`, \`last_seen\`, \`msg_count\`, \`llm_tokens\`, \`auth_count\`, \`status\`)
        VALUES (?, ?, ?, 1, 0, 0, 'active');
      `, uid, now, now);
    }
  }

  // 更新用户LLM token消耗
  handleUserAddTokens(uid: string, tokens: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE `users` SET `llm_tokens` = `llm_tokens` + ? WHERE `uid` = ?;",
      tokens, uid
    );
  }

  // 获取用户列表
  handleUserList(filter?: UserFilter): UserInfo[] {
    let sql = "SELECT * FROM `users` WHERE 1=1";
    const params: any[] = [];
    
    if (filter?.status) {
      sql += " AND `status` = ?";
      params.push(filter.status);
    }
    
    sql += " ORDER BY `last_seen` DESC";
    
    if (filter?.limit) {
      sql += ` LIMIT ${filter.limit}`;
    } else {
      sql += " LIMIT 100";
    }
    if (filter?.offset) {
      sql += ` OFFSET ${filter.offset}`;
    }
    
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const users: UserInfo[] = [];
    for (const row of cursor) {
      users.push({
        uid: row.uid as string,
        firstSeen: row.first_seen as number,
        lastSeen: row.last_seen as number,
        nickname: row.nickname as string | undefined,
        msgCount: row.msg_count as number,
        llmTokens: row.llm_tokens as number,
        authCount: row.auth_count as number,
        lastAuth: row.last_auth as number | undefined,
        status: row.status as "active" | "banned",
        extra: row.extra as string | undefined
      });
    }
    return users;
  }

  // 获取单个用户详情
  handleUserDetail(uid: string): UserInfo | null {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM `users` WHERE `uid` = ?;", uid).toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      uid: row.uid as string,
      firstSeen: row.first_seen as number,
      lastSeen: row.last_seen as number,
      nickname: row.nickname as string | undefined,
      msgCount: row.msg_count as number,
      llmTokens: row.llm_tokens as number,
      authCount: row.auth_count as number,
      lastAuth: row.last_auth as number | undefined,
      status: row.status as "active" | "banned",
      extra: row.extra as string | undefined
    };
  }

  // 封禁/解封用户
  handleUserBan(uid: string, banned: boolean): void {
    this.ctx.storage.sql.exec(
      "UPDATE `users` SET `status` = ? WHERE `uid` = ?;",
      banned ? "banned" : "active", uid
    );
  }

  // 检查用户是否被封禁
  handleUserIsBanned(uid: string): boolean {
    const rows = this.ctx.storage.sql.exec("SELECT `status` FROM `users` WHERE `uid` = ?;", uid).toArray();
    if (rows.length === 0) return false;
    return rows[0]?.status === "banned";
  }

  // ============== 认证记录方法 ==============

  // 插入认证记录
  handleAuthLogInsert(auth: AuthLogEntry): number {
    const result = this.ctx.storage.sql.exec(`
      INSERT INTO \`auth_logs\` (\`uid\`, \`timestamp\`, \`auth_type\`, \`ticket\`, \`success\`, \`ip\`, \`user_agent\`, \`extra\`)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING \`id\`;
    `, auth.uid, auth.timestamp, auth.authType, auth.ticket || null, auth.success ? 1 : 0, auth.ip || null, auth.userAgent || null, auth.extra || null);
    
    // 更新用户认证次数
    if (auth.success) {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "UPDATE `users` SET `auth_count` = `auth_count` + 1, `last_auth` = ? WHERE `uid` = ?;",
        now, auth.uid
      );
    }
    
    return result.one().id as number;
  }

  // 查询认证记录
  handleAuthLogQuery(filter?: AuthFilter): AuthLogEntry[] {
    let sql = "SELECT * FROM `auth_logs` WHERE 1=1";
    const params: any[] = [];
    
    if (filter?.uid) {
      sql += " AND `uid` = ?";
      params.push(filter.uid);
    }
    if (filter?.authType) {
      sql += " AND `auth_type` = ?";
      params.push(filter.authType);
    }
    if (filter?.success !== undefined) {
      sql += " AND `success` = ?";
      params.push(filter.success ? 1 : 0);
    }
    if (filter?.startTime) {
      sql += " AND `timestamp` >= ?";
      params.push(filter.startTime);
    }
    if (filter?.endTime) {
      sql += " AND `timestamp` <= ?";
      params.push(filter.endTime);
    }
    
    sql += " ORDER BY `timestamp` DESC";
    
    if (filter?.limit) {
      sql += ` LIMIT ${filter.limit}`;
    } else {
      sql += " LIMIT 100";
    }
    if (filter?.offset) {
      sql += ` OFFSET ${filter.offset}`;
    }
    
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const logs: AuthLogEntry[] = [];
    for (const row of cursor) {
      logs.push({
        id: row.id as number,
        uid: row.uid as string,
        timestamp: row.timestamp as number,
        authType: row.auth_type as "scan" | "code" | "verify",
        ticket: row.ticket as string | undefined,
        success: (row.success as number) === 1,
        ip: row.ip as string | undefined,
        userAgent: row.user_agent as string | undefined,
        extra: row.extra as string | undefined
      });
    }
    return logs;
  }

  // ============== 聚合会话日志方法 ==============

  // 插入聚合会话日志
  async handleSessionLogInsert(log: SessionLog): Promise<number> {
    const result = this.ctx.storage.sql.exec(`
      INSERT INTO \`session_logs\` (
        \`session_id\`, \`timestamp\`, \`uid\`, \`msg_type\`, \`input_content\`, \`output_content\`,
        \`total_duration\`, \`steps\`, \`ip\`, \`user_agent\`, \`method\`, \`path\`, \`status\`, \`extra\`
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING \`id\`;
    `,
      log.sessionId,
      log.timestamp,
      log.uid,
      log.msgType,
      log.inputContent || null,
      log.outputContent || null,
      log.totalDuration || null,
      JSON.stringify(log.steps),
      log.ip || null,
      log.userAgent || null,
      log.method || null,
      log.path || null,
      log.status,
      log.extra || null
    );

    const id = result.one().id as number;
    log.id = id;

    // 广播给实时日志监听客户端
    this.#broadcastSessionLog(log);

    // 更新用户信息
    if (log.uid) {
      await this.handleUserTouch(log.uid);
    }

    return id;
  }

  // 广播聚合日志给实时监听客户端
  #broadcastSessionLog(log: SessionLog): void {
    const message = JSON.stringify({ type: "session_log", data: log });
    const encoded = new TextEncoder().encode(`data: ${message}\n\n`);

    for (const [clientId, writer] of this.#LoggerClients) {
      writer.write(encoded).catch(() => {
        this.#LoggerClients.delete(clientId);
      });
    }
  }

  // 查询聚合会话日志列表
  handleSessionLogQuery(filter?: {
    uid?: string;
    msgType?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
  }): SessionLog[] {
    let sql = "SELECT * FROM `session_logs` WHERE 1=1";
    const params: any[] = [];

    if (filter?.uid) {
      sql += " AND `uid` = ?";
      params.push(filter.uid);
    }
    if (filter?.msgType) {
      sql += " AND `msg_type` = ?";
      params.push(filter.msgType);
    }
    if (filter?.startTime) {
      sql += " AND `timestamp` >= ?";
      params.push(filter.startTime);
    }
    if (filter?.endTime) {
      sql += " AND `timestamp` <= ?";
      params.push(filter.endTime);
    }

    sql += " ORDER BY `timestamp` DESC";

    if (filter?.limit) {
      sql += ` LIMIT ${filter.limit}`;
    } else {
      sql += " LIMIT 100";
    }
    if (filter?.offset) {
      sql += ` OFFSET ${filter.offset}`;
    }

    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const logs: SessionLog[] = [];
    for (const row of cursor) {
      logs.push({
        id: row.id as number,
        sessionId: row.session_id as string,
        timestamp: row.timestamp as number,
        uid: row.uid as string,
        msgType: row.msg_type as "text" | "event" | "image" | "voice" | "command",
        inputContent: row.input_content as string | undefined,
        outputContent: row.output_content as string | undefined,
        totalDuration: row.total_duration as number | undefined,
        steps: JSON.parse((row.steps as string) || "[]") as PipelineStep[],
        ip: row.ip as string | undefined,
        userAgent: row.user_agent as string | undefined,
        method: row.method as string | undefined,
        path: row.path as string | undefined,
        status: row.status as number,
        extra: row.extra as string | undefined
      });
    }
    return logs;
  }

  // 获取单条聚合会话日志详情
  handleSessionLogDetail(id: number): SessionLog | null {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM `session_logs` WHERE `id` = ?;", id).toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      uid: row.uid as string,
      msgType: row.msg_type as "text" | "event" | "image" | "voice" | "command",
      inputContent: row.input_content as string | undefined,
      outputContent: row.output_content as string | undefined,
      totalDuration: row.total_duration as number | undefined,
      steps: JSON.parse((row.steps as string) || "[]") as PipelineStep[],
      ip: row.ip as string | undefined,
      userAgent: row.user_agent as string | undefined,
      method: row.method as string | undefined,
      path: row.path as string | undefined,
      status: row.status as number,
      extra: row.extra as string | undefined
    };
  }

  // ============== 实时日志WebSocket ==============

  // 接受实时日志SSE连接
  async handleLoggerSSE(request: Request): Promise<Response> {
    const clientId = Utils.random_string(16);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    
    request.signal.addEventListener("abort", () => {
      this.#LoggerClients.delete(clientId);
      try { writer.close(); } catch {}
    });
    
    this.#LoggerClients.set(clientId, writer);
    
    // 发送连接成功消息
    const welcomeMsg = JSON.stringify({ type: "connected", clientId });
    await writer.write(new TextEncoder().encode(`data: ${welcomeMsg}\n\n`));
    
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}