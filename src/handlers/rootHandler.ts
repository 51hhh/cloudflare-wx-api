import { Durable } from "../index";
import { WxCipher } from "../utils/cipher";
import { XmlWxMsg } from "../utils/shard.d";
import { Utils } from "../utils/utils";
import { createPipeline } from "../utils/pipeline";
import { handleCommand, registerEnvCommands } from "./quickCommandHandler";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

// 构建 XML 回复
function buildXmlReply(fromUser: string, toUser: string, content: string): string {
  const xmlReply = {
    xml: {
      ToUserName: fromUser,
      FromUserName: toUser,
      CreateTime: Math.floor(Date.now() / 1000).toString(),
      MsgType: "text",
      Content: content
    }
  };
  return new XMLBuilder().build(xmlReply);
}

// 处理关注事件
async function actionSubscribe(
  xmlMsg: XmlWxMsg,
  env: Env,
  durable: DurableObjectStub<Durable>,
  request: Request,
  ctx?: ExecutionContext
): Promise<string> {
  const pipeline = createPipeline(durable, request, env)
    .setUser(xmlMsg.FromUserName)
    .setMsgType("event")
    .setInput("subscribe");

  const receiveStep = pipeline.startStep("receive");
  pipeline.endStep(receiveStep, true, { event: "subscribe" });

  const content = "[你好呀~] 感谢关注TinAI生态\n\n限于微信的响应时长限制，对话时可能出现长内容无法及时回复的情况，此时发送：\n/pre\n可获取上一次未及时生成的回复哦\n\n发送 /help 查看更多命令";

  pipeline.setOutput(content).setStatus(200);

  const sendStep = pipeline.startStep("send");
  const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
  pipeline.endStep(sendStep, true);

  // 异步提交日志
  pipeline.commitAsync(ctx);

  return reply;
}

// 处理获取验证码
async function actionCode(
  xmlMsg: XmlWxMsg,
  durable: DurableObjectStub<Durable>,
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<string> {
  const pipeline = createPipeline(durable, request, env)
    .setUser(xmlMsg.FromUserName)
    .setMsgType("event")
    .setInput("GetCode");

  const receiveStep = pipeline.startStep("receive");
  pipeline.endStep(receiveStep, true, { event: "GetCode" });

  const dbStep = pipeline.startStep("db");
  const code = await durable.handleGetCodeByUid(xmlMsg.FromUserName);
  pipeline.endStep(dbStep, true, { code });

  const content = "您的登录验证码是：" + code + "\n该验证码5分钟内有效";
  pipeline.setOutput(content).setStatus(200);

  const sendStep = pipeline.startStep("send");
  const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
  pipeline.endStep(sendStep, true);

  pipeline.commitAsync(ctx);
  return reply;
}

// 处理新建对话
async function actionNewChat(
  xmlMsg: XmlWxMsg,
  durable: DurableObjectStub<Durable>,
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<string> {
  const pipeline = createPipeline(durable, request, env)
    .setUser(xmlMsg.FromUserName)
    .setMsgType("event")
    .setInput("NewChat");

  const receiveStep = pipeline.startStep("receive");
  pipeline.endStep(receiveStep, true, { event: "NewChat" });

  const dbStep = pipeline.startStep("db");
  const content = await durable.handleClearChatHistory(xmlMsg.FromUserName);
  pipeline.endStep(dbStep, true);

  pipeline.setOutput(content).setStatus(200);

  const sendStep = pipeline.startStep("send");
  const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
  pipeline.endStep(sendStep, true);

  pipeline.commitAsync(ctx);
  return reply;
}

// 处理扫码
async function actionScan(
  xmlMsg: XmlWxMsg,
  env: Env,
  durable: DurableObjectStub<Durable>,
  request: Request,
  ctx?: ExecutionContext
): Promise<string> {
  const pipeline = createPipeline(durable, request, env)
    .setUser(xmlMsg.FromUserName)
    .setMsgType("event")
    .setInput(xmlMsg.ScanCodeInfo?.ScanResult || "scan");

  const receiveStep = pipeline.startStep("receive");
  const raw = xmlMsg.ScanCodeInfo?.ScanResult || "";
  pipeline.endStep(receiveStep, true, { scanResult: raw });

  let content = "emmm~，看起来不像我认识的登录二维码：\n" + raw;
  let success = false;

  const ticket = raw.startsWith(env.TicketPrefix) ? raw.substring(env.TicketPrefix.length) : "";

  if (ticket && ticket.length === env.TicketSize) {
    const dbStep = pipeline.startStep("db");
    content = await durable.handleQrcodeLogin(ticket, xmlMsg.FromUserName);
    success = content.includes("登录成功");
    pipeline.endStep(dbStep, success, { ticket, success });
  }

  pipeline.setOutput(content).setStatus(success ? 200 : 400);

  const sendStep = pipeline.startStep("send");
  const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
  pipeline.endStep(sendStep, true);

  pipeline.commitAsync(ctx);
  return reply;
}

// 处理文本消息 - 核心重构
async function actionText(
  xmlMsg: XmlWxMsg,
  env: Env,
  durable: DurableObjectStub<Durable>,
  request: Request,
  ctx?: ExecutionContext
): Promise<string> {
  const userContent = xmlMsg.Content || "";

  const pipeline = createPipeline(durable, request, env)
    .setUser(xmlMsg.FromUserName)
    .setInput(userContent);

  // 1. 接收阶段
  const receiveStep = pipeline.startStep("receive");
  pipeline.endStep(receiveStep, true, { content: userContent });

  // 2. 检查是否是快捷命令
  const commandStep = pipeline.startStep("command");
  const cmdResult = await handleCommand(userContent, xmlMsg.FromUserName, env, durable);

  if (cmdResult.handled) {
    // 命令已处理
    pipeline.setMsgType("command");
    pipeline.endStep(commandStep, true, {
      type: cmdResult.extra?.type || "command",
      shouldLog: cmdResult.shouldLog
    });

    const content = cmdResult.content || "命令执行成功";
    pipeline.setOutput(content).setStatus(200);

    // 记录会话（如果需要）
    if (cmdResult.shouldLog) {
      const dbStep = pipeline.startStep("db");
      await pipeline.logUserMessage();
      await pipeline.logAssistantMessage();
      pipeline.endStep(dbStep, true);
    }

    const sendStep = pipeline.startStep("send");
    const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
    pipeline.endStep(sendStep, true);

    pipeline.commitAsync(ctx);
    return reply;
  }

  // 非命令，继续走 LLM
  pipeline.setMsgType("text");
  pipeline.endStep(commandStep, false, { reason: "not_command" });

  let content: string;

  try {
    // 3. 更新对话历史
    const dbStep1 = pipeline.startStep("db");
    let messages = await durable.handleUpdateChatHistory(xmlMsg.FromUserName, {
      role: "user",
      content: userContent
    });
    messages = messages.filter(m => m.content !== null && m.content !== undefined && m.content !== "");
    pipeline.endStep(dbStep1, true, { messagesCount: messages.length });

    // 4. 调用 LLM
    const llmStep = pipeline.startStep("llm");
    const llmRes = await env.AI.run(
      env.LLMModelId,
      { messages, max_tokens: env.LLMMaxLength },
      { returnRawResponse: false }
    ) as any;

    // 兼容不同的响应格式
    content = llmRes?.response ||
              llmRes?.result?.response ||
              llmRes?.choices?.[0]?.message?.content || "";

    // 清理开头和结尾的空白字符（LLM 经常在开头返回换行）
    content = content.trim();

    if (!content) {
      content = "抱歉，AI暂时无法回复，请稍后再试";
      console.log("LLM returned empty response:", JSON.stringify(llmRes));
    }

    // 提取 token 使用量
    const usage = llmRes?.usage || llmRes?.result?.usage || {};
    const promptTokens = usage.prompt_tokens || usage.input_tokens || 0;
    const completionTokens = usage.completion_tokens || usage.output_tokens || 0;
    const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

    pipeline.endStep(llmStep, !!content, {
      model: env.LLMModelId,
      promptTokens,
      completionTokens,
      totalTokens,
      maxTokens: env.LLMMaxLength,
      responsePreview: content.substring(0, 100),
      rawResponse: JSON.stringify(llmRes).substring(0, 500)
    });

    // 更新用户 token 消耗
    if (totalTokens > 0) {
      await durable.handleUserAddTokens(xmlMsg.FromUserName, totalTokens);
    }

    // 5. 保存 AI 回复到历史
    const dbStep2 = pipeline.startStep("db");
    await durable.handleUpdateChatHistory(xmlMsg.FromUserName, {
      role: "assistant",
      content
    });

    // 记录会话
    await pipeline.logUserMessage();
    pipeline.setOutput(content);
    await pipeline.logAssistantMessage(llmStep.duration, totalTokens);
    pipeline.endStep(dbStep2, true);

    pipeline.setStatus(200);

  } catch (e: any) {
    console.error("LLM call error:", e);
    content = "啊哦，对面被你问宕机了~";

    const errorStep = pipeline.startStep("error");
    pipeline.endStep(errorStep, false, {
      error: e.message,
      stack: e.stack
    });

    pipeline.setOutput(content).setStatus(500);
  }

  // 6. 发送回复
  const sendStep = pipeline.startStep("send");
  const reply = buildXmlReply(xmlMsg.FromUserName, xmlMsg.ToUserName, content);
  pipeline.endStep(sendStep, true);

  // 异步提交日志
  pipeline.commitAsync(ctx);

  return reply;
}

// 不支持的消息类型
function actionTextOnly(xmlMsg: XmlWxMsg, text?: string): string {
  return buildXmlReply(
    xmlMsg.FromUserName,
    xmlMsg.ToUserName,
    text || "[叮叮~] 当前仅支持文字消息哈"
  );
}

// 主消息分发
async function action(
  xmlMsg: XmlWxMsg,
  env: Env,
  durable: DurableObjectStub<Durable>,
  request: Request,
  ctx?: ExecutionContext
): Promise<string> {
  // 注册环境相关的命令
  registerEnvCommands(env);

  if (xmlMsg.MsgType === "event") {
    if (xmlMsg.Event === "subscribe") {
      return actionSubscribe(xmlMsg, env, durable, request, ctx);
    } else if (xmlMsg.EventKey === "GetCode") {
      return actionCode(xmlMsg, durable, request, env, ctx);
    } else if (xmlMsg.EventKey === "CallScan") {
      return actionScan(xmlMsg, env, durable, request, ctx);
    } else if (xmlMsg.EventKey === "NewChat") {
      return actionNewChat(xmlMsg, durable, request, env, ctx);
    }
    return "unhandled event type: " + xmlMsg.Event;
  } else if (xmlMsg.MsgType === "text") {
    return actionText(xmlMsg, env, durable, request, ctx);
  }
  return actionTextOnly(xmlMsg);
}

// AES 验签
async function verifyAes(xmlMsg: XmlWxMsg, args: { [k: string]: string }, token: string): Promise<boolean> {
  return args.msg_signature === await Utils.sha1(args.timestamp, args.nonce, xmlMsg.Encrypt, token);
}

// AES 加密回复
async function encryptAes(replyEncoded: string, token: string): Promise<string> {
  const nonce = Utils.random_string(7, "0123456789");
  const timestamp = Utils.time_now();
  const msgSignature = await Utils.sha1(timestamp, nonce, token, replyEncoded);
  const xmlReplyOuter = {
    xml: {
      Encrypt: replyEncoded,
      MsgSignature: msgSignature,
      TimeStamp: timestamp,
      Nonce: nonce
    }
  };
  return new XMLBuilder().build(xmlReplyOuter);
}

// AES 模式处理
async function actionAes(
  request: Request,
  env: Env,
  durable: DurableObjectStub<Durable>,
  ctx?: ExecutionContext
): Promise<string> {
  const xmlParser = new XMLParser();
  try {
    const strAesMsg = await request.text();
    const xmlAesMsg = xmlParser.parse(strAesMsg).xml;
    const args = Object.fromEntries(new URL(request.url).searchParams);
    if (!await verifyAes(xmlAesMsg, args, env.AppToken)) {
      return "Signature Failed";
    }
    const cipher = new WxCipher(env.AppID, env.AppAesKey);
    const strMsg = await cipher.decrypt(xmlAesMsg.Encrypt);
    const xmlMsg = xmlParser.parse(strMsg).xml as XmlWxMsg;
    const strReply = await action(xmlMsg, env, durable, request, ctx);
    return encryptAes(await cipher.encrypt(strReply), env.AppToken);
  } catch (e) {
    console.log("Aes Action Error:", e);
    return "Failed";
  }
}

// 明文验签
async function verifyPlain(args: { [k: string]: string }, token: string): Promise<boolean> {
  return args.signature === await Utils.sha1(token, args.timestamp, args.nonce);
}

// 明文模式处理
async function actionPlain(
  request: Request,
  env: Env,
  durable: DurableObjectStub<Durable>,
  ctx?: ExecutionContext
): Promise<string> {
  const xmlParser = new XMLParser();
  try {
    const args = Object.fromEntries(new URL(request.url).searchParams);
    if (!await verifyPlain(args, env.AppToken)) {
      return "Signature Failed";
    }
    const strMsg = await request.text();
    const xmlMsg = xmlParser.parse(strMsg).xml as XmlWxMsg;
    return action(xmlMsg, env, durable, request, ctx);
  } catch (e) {
    console.log("Root Plain Action:", e);
    return "Failed";
  }
}

// 主入口
export async function rootHandler(
  request: Request,
  env: Env,
  durable: DurableObjectStub<Durable>,
  ctx?: ExecutionContext
): Promise<Response> {
  let reply = "Method Not Allowed";
  if (request.method === "POST") {
    reply = await (env.AesMode ? actionAes : actionPlain)(request, env, durable, ctx);
  } else if (request.method === "GET") {
    const args = Object.fromEntries(new URL(request.url).searchParams);
    reply = (await verifyPlain(args, env.AppToken)) ? args.echostr || "Success" : "Failed";
  }
  return new Response(reply);
}
