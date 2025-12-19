import { Durable } from "../utils/durable";
import { Utils } from "../utils/utils";
import { LogFilter, UserFilter, AuthFilter, LogType } from "../utils/shard.d";

/**
 * 验证管理员Token
 */
function verifyToken(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token");
  return token === env.AdminToken;
}

/**
 * 返回JSON响应
 */
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
    }
  });
}

/**
 * 处理API请求
 */
async function handleApi(
  request: Request,
  env: Env,
  path: string[],
  durable: DurableObjectStub<Durable>
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // 获取统计信息
  if (path[0] === "stats") {
    const stats = await durable.handleLogStats();
    return jsonResponse({ code: 200, data: stats });
  }

  // 日志相关
  if (path[0] === "logs") {
    if (path.length === 1) {
      // 查询日志列表
      const filter: LogFilter = {
        type: url.searchParams.get("type") as LogType | undefined,
        uid: url.searchParams.get("uid") || undefined,
        startTime: url.searchParams.get("startTime") ? parseInt(url.searchParams.get("startTime")!) : undefined,
        endTime: url.searchParams.get("endTime") ? parseInt(url.searchParams.get("endTime")!) : undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 50,
        offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : 0
      };
      const logs = await durable.handleLogQuery(filter);
      return jsonResponse({ code: 200, data: logs });
    } else if (path[1] === "export") {
      // 导出日志
      const filter: LogFilter = {
        type: url.searchParams.get("type") as LogType | undefined,
        uid: url.searchParams.get("uid") || undefined,
        startTime: url.searchParams.get("startTime") ? parseInt(url.searchParams.get("startTime")!) : undefined,
        endTime: url.searchParams.get("endTime") ? parseInt(url.searchParams.get("endTime")!) : undefined,
        limit: 1000
      };
      const logs = await durable.handleLogQuery(filter);
      return new Response(JSON.stringify(logs, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="logs-${Date.now()}.json"`,
          "Access-Control-Allow-Origin": "*"
        }
      });
    } else {
      // 获取单条日志详情
      const id = parseInt(path[1]);
      if (isNaN(id)) {
        return jsonResponse({ code: 400, msg: "Invalid log ID" }, 400);
      }
      const log = await durable.handleLogDetail(id);
      if (!log) {
        return jsonResponse({ code: 404, msg: "Log not found" }, 404);
      }
      return jsonResponse({ code: 200, data: log });
    }
  }

  // 会话相关
  if (path[0] === "conversations") {
    if (path.length === 1) {
      // 获取会话列表
      const conversations = await durable.handleConversationList();
      return jsonResponse({ code: 200, data: conversations });
    } else if (path.length === 2) {
      // 获取指定用户的对话详情
      const uid = decodeURIComponent(path[1]);
      const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 100;
      const messages = await durable.handleConversationDetail(uid, limit);
      return jsonResponse({ code: 200, data: messages });
    } else if (path.length === 3 && path[2] === "export") {
      // 导出用户对话
      const uid = decodeURIComponent(path[1]);
      const messages = await durable.handleConversationDetail(uid, 1000);
      return new Response(JSON.stringify(messages, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="conversation-${uid.substring(0, 8)}-${Date.now()}.json"`,
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }

  // 用户相关
  if (path[0] === "users") {
    if (path.length === 1) {
      // 获取用户列表
      const filter: UserFilter = {
        status: url.searchParams.get("status") as "active" | "banned" | undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 50,
        offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : 0
      };
      const users = await durable.handleUserList(filter);
      return jsonResponse({ code: 200, data: users });
    } else if (path.length === 2) {
      // 获取单个用户详情
      const uid = decodeURIComponent(path[1]);
      const user = await durable.handleUserDetail(uid);
      if (!user) {
        return jsonResponse({ code: 404, msg: "User not found" }, 404);
      }
      return jsonResponse({ code: 200, data: user });
    } else if (path.length === 3) {
      // 用户操作
      const uid = decodeURIComponent(path[1]);
      if (path[2] === "ban" && method === "POST") {
        await durable.handleUserBan(uid, true);
        return jsonResponse({ code: 200, msg: "User banned" });
      } else if (path[2] === "unban" && method === "POST") {
        await durable.handleUserBan(uid, false);
        return jsonResponse({ code: 200, msg: "User unbanned" });
      } else if (path[2] === "conversations") {
        const messages = await durable.handleConversationDetail(uid, 100);
        return jsonResponse({ code: 200, data: messages });
      }
    }
  }

  // 认证记录相关
  if (path[0] === "auth") {
    if (path.length === 1) {
      // 获取认证记录列表
      const filter: AuthFilter = {
        uid: url.searchParams.get("uid") || undefined,
        authType: url.searchParams.get("authType") as "scan" | "code" | "verify" | undefined,
        success: url.searchParams.get("success") !== null ? url.searchParams.get("success") === "true" : undefined,
        startTime: url.searchParams.get("startTime") ? parseInt(url.searchParams.get("startTime")!) : undefined,
        endTime: url.searchParams.get("endTime") ? parseInt(url.searchParams.get("endTime")!) : undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 50,
        offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : 0
      };
      const authLogs = await durable.handleAuthLogQuery(filter);
      return jsonResponse({ code: 200, data: authLogs });
    } else if (path.length === 2) {
      // 获取指定用户的认证历史
      const uid = decodeURIComponent(path[1]);
      const authLogs = await durable.handleAuthLogQuery({ uid, limit: 100 });
      return jsonResponse({ code: 200, data: authLogs });
    }
  }

  // 聚合会话日志相关（新增）
  if (path[0] === "sessions") {
    if (path.length === 1) {
      // 获取聚合会话日志列表
      const filter = {
        uid: url.searchParams.get("uid") || undefined,
        msgType: url.searchParams.get("msgType") || undefined,
        startTime: url.searchParams.get("startTime") ? parseInt(url.searchParams.get("startTime")!) : undefined,
        endTime: url.searchParams.get("endTime") ? parseInt(url.searchParams.get("endTime")!) : undefined,
        limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 50,
        offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!) : 0
      };
      const sessions = await durable.handleSessionLogQuery(filter);
      return jsonResponse({ code: 200, data: sessions });
    } else if (path[1] === "export") {
      // 导出聚合会话日志
      const filter = {
        uid: url.searchParams.get("uid") || undefined,
        msgType: url.searchParams.get("msgType") || undefined,
        startTime: url.searchParams.get("startTime") ? parseInt(url.searchParams.get("startTime")!) : undefined,
        endTime: url.searchParams.get("endTime") ? parseInt(url.searchParams.get("endTime")!) : undefined,
        limit: 1000
      };
      const sessions = await durable.handleSessionLogQuery(filter);
      return new Response(JSON.stringify(sessions, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="sessions-${Date.now()}.json"`,
          "Access-Control-Allow-Origin": "*"
        }
      });
    } else {
      // 获取单条聚合会话日志详情
      const id = parseInt(path[1]);
      if (isNaN(id)) {
        return jsonResponse({ code: 400, msg: "Invalid session ID" }, 400);
      }
      const session = await durable.handleSessionLogDetail(id);
      if (!session) {
        return jsonResponse({ code: 404, msg: "Session not found" }, 404);
      }
      return jsonResponse({ code: 200, data: session });
    }
  }

  return jsonResponse({ code: 404, msg: "API not found" }, 404);
}

/**
 * Logger管理后台处理器
 */
export async function loggerHandler(
  request: Request,
  env: Env,
  path: string[],
  durable: DurableObjectStub<Durable>
): Promise<Response> {
  // 处理CORS预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  // 验证Token (除了OPTIONS请求)
  if (!verifyToken(request, env)) {
    return jsonResponse({ code: 401, msg: "Unauthorized" }, 401);
  }

  // 根路径 - 返回管理界面
  if (path.length === 0) {
    const url = new URL(request.url);
    return env.Assets.fetch(`${url.origin}/logger.html`);
  }

  // SSE实时日志流
  if (path[0] === "sse") {
    return durable.handleLoggerSSE(request);
  }

  // API路由
  if (path[0] === "api" && path.length >= 2) {
    return handleApi(request, env, path.slice(1), durable);
  }

  return jsonResponse({ code: 404, msg: "Not found" }, 404);
}
