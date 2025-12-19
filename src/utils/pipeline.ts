import { Durable } from "./durable";
import { SessionLog, PipelineStep, PipelineStage } from "./shard.d";
import { Utils } from "./utils";

/**
 * 消息处理管道 - 统一处理所有消息类型
 * 设计原则：
 * 1. 优先回复用户（5秒内）
 * 2. 异步记录日志和数据库
 * 3. 聚合所有步骤到一条日志
 */
export class MessagePipeline {
  private durable: DurableObjectStub<Durable>;
  private request: Request;
  private env: Env;
  
  private sessionId: string;
  private startTime: number;
  private steps: PipelineStep[] = [];
  private uid: string = "";
  private msgType: "text" | "event" | "image" | "voice" | "command" = "text";
  private inputContent: string = "";
  private outputContent: string = "";
  private status: number = 200;

  constructor(durable: DurableObjectStub<Durable>, request: Request, env: Env) {
    this.durable = durable;
    this.request = request;
    this.env = env;
    this.sessionId = Utils.random_string(16);
    this.startTime = Date.now();
  }

  /**
   * 设置用户信息
   */
  setUser(uid: string): this {
    this.uid = uid;
    return this;
  }

  /**
   * 设置消息类型
   */
  setMsgType(type: "text" | "event" | "image" | "voice" | "command"): this {
    this.msgType = type;
    return this;
  }

  /**
   * 设置输入内容
   */
  setInput(content: string): this {
    this.inputContent = content;
    return this;
  }

  /**
   * 设置输出内容
   */
  setOutput(content: string): this {
    this.outputContent = content;
    return this;
  }

  /**
   * 设置最终状态码
   */
  setStatus(status: number): this {
    this.status = status;
    return this;
  }

  /**
   * 开始一个处理阶段
   */
  startStep(stage: PipelineStage): PipelineStep {
    const step: PipelineStep = {
      stage,
      startTime: Date.now(),
      success: false
    };
    this.steps.push(step);
    return step;
  }

  /**
   * 完成一个处理阶段
   */
  endStep(step: PipelineStep, success: boolean, data?: any, error?: string): void {
    step.endTime = Date.now();
    step.duration = step.endTime - step.startTime;
    step.success = success;
    step.data = data;
    step.error = error;
  }

  /**
   * 快速添加一个完成的步骤
   */
  addStep(stage: PipelineStage, success: boolean, duration: number, data?: any, error?: string): void {
    this.steps.push({
      stage,
      startTime: this.startTime,
      endTime: this.startTime + duration,
      duration,
      success,
      data,
      error
    });
  }

  /**
   * 获取请求基本信息
   */
  private getRequestInfo(): { ip?: string; userAgent?: string; method: string; path: string } {
    const url = new URL(this.request.url);
    return {
      ip: this.request.headers.get("cf-connecting-ip") || 
          this.request.headers.get("x-forwarded-for") || 
          undefined,
      userAgent: this.request.headers.get("user-agent") || undefined,
      method: this.request.method,
      path: url.pathname
    };
  }

  /**
   * 构建聚合日志
   */
  private buildSessionLog(): SessionLog {
    const info = this.getRequestInfo();
    return {
      sessionId: this.sessionId,
      timestamp: this.startTime,
      uid: this.uid,
      msgType: this.msgType,
      inputContent: this.inputContent,
      outputContent: this.outputContent,
      totalDuration: Date.now() - this.startTime,
      steps: this.steps,
      ip: info.ip,
      userAgent: info.userAgent,
      method: info.method,
      path: info.path,
      status: this.status
    };
  }

  /**
   * 异步提交日志（不阻塞响应）
   * 使用 waitUntil 或 fire-and-forget 方式
   */
  async commitAsync(ctx?: ExecutionContext): Promise<void> {
    const log = this.buildSessionLog();
    
    // 如果有 ExecutionContext，使用 waitUntil 保证日志写入
    if (ctx) {
      ctx.waitUntil(this.durable.handleSessionLogInsert(log));
    } else {
      // 否则 fire-and-forget（不等待）
      this.durable.handleSessionLogInsert(log).catch((e: Error) => {
        console.error("Failed to commit session log:", e);
      });
    }
  }

  /**
   * 同步提交日志（阻塞等待）
   */
  async commit(): Promise<number> {
    const log = this.buildSessionLog();
    return this.durable.handleSessionLogInsert(log);
  }

  /**
   * 获取会话ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 获取总耗时
   */
  getTotalDuration(): number {
    return Date.now() - this.startTime;
  }

  /**
   * 获取所有步骤
   */
  getSteps(): PipelineStep[] {
    return this.steps;
  }

  /**
   * 记录用户消息到会话历史（异步）
   */
  async logUserMessage(): Promise<void> {
    if (!this.inputContent || !this.uid) return;
    
    await this.durable.handleConversationInsert({
      uid: this.uid,
      timestamp: this.startTime,
      role: "user",
      content: this.inputContent,
      msgType: this.msgType
    });
  }

  /**
   * 记录AI回复到会话历史（异步）
   */
  async logAssistantMessage(duration?: number, tokens?: number): Promise<void> {
    if (!this.outputContent || !this.uid) return;
    
    await this.durable.handleConversationInsert({
      uid: this.uid,
      timestamp: Date.now(),
      role: "assistant",
      content: this.outputContent,
      msgType: "text",
      duration,
      tokens
    });
  }
}

/**
 * 创建消息管道的工厂函数
 */
export function createPipeline(
  durable: DurableObjectStub<Durable>, 
  request: Request, 
  env: Env
): MessagePipeline {
  return new MessagePipeline(durable, request, env);
}
