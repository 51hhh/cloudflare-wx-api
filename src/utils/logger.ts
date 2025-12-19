import { Durable } from "./durable";
import { LogEntry, LogType, ConversationMessage, AuthLogEntry } from "./shard.d";

/**
 * 日志工具类 - 提供便捷的日志记录方法
 * 可剥离设计：如需移除日志功能，删除此文件并移除相关调用即可
 */
export class Logger {
  private durable: DurableObjectStub<Durable>;
  private request: Request;

  constructor(durable: DurableObjectStub<Durable>, request: Request) {
    this.durable = durable;
    this.request = request;
  }

  /**
   * 获取请求的基本信息
   */
  private getRequestInfo(): { ip?: string; userAgent?: string; method: string; path: string } {
    const url = new URL(this.request.url);
    return {
      ip: this.request.headers.get("cf-connecting-ip") || this.request.headers.get("x-forwarded-for") || undefined,
      userAgent: this.request.headers.get("user-agent") || undefined,
      method: this.request.method,
      path: url.pathname
    };
  }

  /**
   * 记录微信消息日志
   */
  async logWxMessage(params: {
    type: "wx_text" | "wx_event" | "wx_image" | "wx_voice";
    uid: string;
    requestBody?: any;
    responseBody?: any;
    status?: number;
    duration?: number;
    extra?: any;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: params.type,
      uid: params.uid,
      method: info.method,
      path: info.path,
      status: params.status || 200,
      duration: params.duration,
      ip: info.ip,
      userAgent: info.userAgent,
      requestBody: params.requestBody ? JSON.stringify(params.requestBody) : undefined,
      responseBody: params.responseBody ? JSON.stringify(params.responseBody) : undefined,
      extra: params.extra ? JSON.stringify(params.extra) : undefined
    };
    return this.durable.handleLogInsert(entry);
  }

  /**
   * 记录LLM调用日志
   */
  async logLLMCall(params: {
    uid: string;
    messagesCount: number;
    maxTokens: number;
    responsePreview?: string;
    tokens?: number;
    duration?: number;
    success: boolean;
    error?: string;
    rawResponse?: string;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: "llm_call",
      uid: params.uid,
      method: info.method,
      path: info.path,
      status: params.success ? 200 : 500,
      duration: params.duration,
      ip: info.ip,
      userAgent: info.userAgent,
      requestBody: JSON.stringify({
        messagesCount: params.messagesCount,
        maxTokens: params.maxTokens
      }),
      responseBody: JSON.stringify({
        tokens: params.tokens,
        preview: params.responsePreview?.substring(0, 100),
        error: params.error,
        raw: params.rawResponse
      }),
      extra: undefined
    };
    return this.durable.handleLogInsert(entry);
  }

  /**
   * 记录OAuth认证日志
   */
  async logOAuth(params: {
    type: "oauth_scan" | "oauth_code" | "oauth_check";
    uid?: string;
    ticket?: string;
    code?: string;
    success: boolean;
    status?: number;
    duration?: number;
    extra?: any;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: params.type,
      uid: params.uid,
      method: info.method,
      path: info.path,
      status: params.status || (params.success ? 200 : 400),
      duration: params.duration,
      ip: info.ip,
      userAgent: info.userAgent,
      requestBody: JSON.stringify({
        ticket: params.ticket,
        code: params.code
      }),
      responseBody: JSON.stringify({
        success: params.success
      }),
      extra: params.extra ? JSON.stringify(params.extra) : undefined
    };
    return this.durable.handleLogInsert(entry);
  }

  /**
   * 记录认证详情
   */
  async logAuth(params: {
    uid: string;
    authType: "scan" | "code" | "verify";
    ticket?: string;
    success: boolean;
    extra?: any;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const auth: AuthLogEntry = {
      uid: params.uid,
      timestamp: Date.now(),
      authType: params.authType,
      ticket: params.ticket,
      success: params.success,
      ip: info.ip,
      userAgent: info.userAgent,
      extra: params.extra ? JSON.stringify(params.extra) : undefined
    };
    return this.durable.handleAuthLogInsert(auth);
  }

  /**
   * 记录会话消息
   */
  async logConversation(params: {
    uid: string;
    role: "user" | "assistant";
    content: string;
    msgType?: string;
    tokens?: number;
    duration?: number;
    logId?: number;
  }): Promise<number> {
    // 确保content不为空，避免数据库约束错误
    if (!params.content) {
      return 0;  // 跳过空内容的记录
    }
    const msg: ConversationMessage = {
      uid: params.uid,
      timestamp: Date.now(),
      role: params.role,
      content: params.content,
      msgType: params.msgType,
      tokens: params.tokens,
      duration: params.duration,
      logId: params.logId
    };
    return this.durable.handleConversationInsert(msg);
  }

  /**
   * 记录错误日志
   */
  async logError(params: {
    uid?: string;
    error: string;
    stack?: string;
    extra?: any;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: "error",
      uid: params.uid,
      method: info.method,
      path: info.path,
      status: 500,
      ip: info.ip,
      userAgent: info.userAgent,
      requestBody: undefined,
      responseBody: JSON.stringify({
        error: params.error,
        stack: params.stack
      }),
      extra: params.extra ? JSON.stringify(params.extra) : undefined
    };
    return this.durable.handleLogInsert(entry);
  }

  /**
   * 记录管理操作日志
   */
  async logAdmin(params: {
    action: string;
    target?: string;
    result?: any;
    status?: number;
  }): Promise<number> {
    const info = this.getRequestInfo();
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: "admin",
      method: info.method,
      path: info.path,
      status: params.status || 200,
      ip: info.ip,
      userAgent: info.userAgent,
      requestBody: JSON.stringify({
        action: params.action,
        target: params.target
      }),
      responseBody: params.result ? JSON.stringify(params.result) : undefined,
      extra: undefined
    };
    return this.durable.handleLogInsert(entry);
  }
}

/**
 * 创建Logger实例的工厂函数
 */
export function createLogger(durable: DurableObjectStub<Durable>, request: Request): Logger {
  return new Logger(durable, request);
}
