export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SseMessage {
  code: number;
  data: any;
}

export interface XmlWxMsg {
  FromUserName: string;
  ToUserName: string;
  MsgType: "event" | "text";
  // aes
  Encrypt: string;
  // text
  Content: string;
  // event
  Event: "subscribe" | "CLICK" | "scancode_waitmsg";
  // scan
  EventKey: "GetCode" | "NewChat" | "CallScan";
  ScanCodeInfo: {
    ScanResult: string;
  }
}

// ============== 管理后台类型定义 ==============

// 日志类型枚举
export type LogType = 
  | "wx_text"      // 微信文本消息
  | "wx_event"     // 微信事件(关注/取关/扫码/菜单)
  | "wx_image"     // 微信图片
  | "wx_voice"     // 微信语音
  | "llm_call"     // LLM调用
  | "oauth_scan"   // 扫码认证
  | "oauth_code"   // 验证码认证
  | "oauth_check"  // 认证状态检查
  | "admin"        // 管理操作
  | "error";       // 错误

// 请求日志条目
export interface LogEntry {
  id?: number;
  timestamp: number;          // Unix时间戳(毫秒)
  type: LogType;              // 日志类型
  uid?: string;               // 用户OpenID
  method?: string;            // HTTP方法
  path?: string;              // 请求路径
  status?: number;            // 响应状态码
  duration?: number;          // 处理耗时(ms)
  ip?: string;                // 请求IP
  userAgent?: string;         // UA
  requestBody?: string;       // 请求体摘要(JSON)
  responseBody?: string;      // 响应体摘要(JSON)
  extra?: string;             // 扩展信息(JSON)
}

// 会话/对话记录
export interface ConversationMessage {
  id?: number;
  uid: string;                // 用户OpenID
  timestamp: number;          // 时间戳
  role: "user" | "assistant"; // 角色
  content: string;            // 消息内容
  msgType?: string;           // text | image | voice | event
  tokens?: number;            // Token消耗(仅assistant)
  duration?: number;          // LLM响应耗时(仅assistant)
  logId?: number;             // 关联的日志ID
}

// 会话摘要(用于列表展示)
export interface ConversationSummary {
  uid: string;                // 用户OpenID
  msgCount: number;           // 消息总数
  lastMessage: string;        // 最后一条消息预览
  lastTime: number;           // 最后消息时间
}

// 用户信息
export interface UserInfo {
  uid: string;                // 用户OpenID
  firstSeen: number;          // 首次出现时间
  lastSeen: number;           // 最后活跃时间
  nickname?: string;          // 昵称
  msgCount: number;           // 消息总数
  llmTokens: number;          // 累计Token消耗
  authCount: number;          // 认证次数
  lastAuth?: number;          // 最后认证时间
  status: "active" | "banned"; // 状态
  extra?: string;             // 扩展信息
}

// 认证记录
export interface AuthLogEntry {
  id?: number;
  uid: string;                // 用户OpenID
  timestamp: number;          // 认证时间
  authType: "scan" | "code" | "verify"; // 认证类型
  ticket?: string;            // 凭证
  success: boolean;           // 是否成功
  ip?: string;                // 请求IP
  userAgent?: string;         // UA
  extra?: string;             // 扩展信息
}

// 日志查询过滤器
export interface LogFilter {
  type?: LogType;
  uid?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

// 用户查询过滤器
export interface UserFilter {
  status?: "active" | "banned";
  limit?: number;
  offset?: number;
}

// 认证查询过滤器
export interface AuthFilter {
  uid?: string;
  authType?: "scan" | "code" | "verify";
  success?: boolean;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

// 统计信息
export interface LogStats {
  totalRequests: number;
  todayRequests: number;
  totalUsers: number;
  activeUsers: number;
  totalLLMCalls: number;
  todayLLMCalls: number;
  totalAuthCount: number;
  todayAuthCount: number;
}

// ============== 聚合型对话日志 ==============

// 消息流水线阶段
export type PipelineStage = "receive" | "command" | "llm" | "db" | "send" | "error";

// 流水线步骤详情
export interface PipelineStep {
  stage: PipelineStage;
  startTime: number;
  endTime?: number;
  duration?: number;
  success: boolean;
  data?: any;            // 阶段特有数据
  error?: string;
}

// 聚合型对话日志（一次完整的用户对话流程）
export interface SessionLog {
  id?: number;
  sessionId: string;        // 唯一会话ID
  timestamp: number;        // 会话开始时间
  uid: string;              // 用户OpenID
  msgType: "text" | "event" | "image" | "voice" | "command"; // 消息类型
  inputContent?: string;    // 用户输入内容
  outputContent?: string;   // 回复内容
  totalDuration?: number;   // 总耗时
  steps: PipelineStep[];    // 各阶段详情
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  status: number;           // 最终状态码
  extra?: string;           // 扩展信息(JSON)
}

// 快捷命令定义
export interface QuickCommand {
  pattern: string | RegExp;  // 匹配模式
  name: string;              // 命令名称
  description: string;       // 描述
  handler: string;           // 处理函数名
}

// 快捷命令处理结果
export interface CommandResult {
  handled: boolean;          // 是否已处理
  content?: string;          // 回复内容
  shouldLog?: boolean;       // 是否需要记录到会话
  extra?: any;               // 扩展数据
}

