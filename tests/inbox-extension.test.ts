import { expect, test } from "bun:test";
import * as typebox from "@oh-my-pi/omptype/typebox";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sessionBus from "../src/index";
import { LocalPeer } from "../src/transport";
import { ConversationBook } from "../src/conversations";
import type { InboxPage, InboxStatus } from "../src/inbox";
import type { AgentMessage, PeerInfo } from "../src/protocol";
import type { QueuedPromptHost } from "../src/queued-prompts";

type Tool = { name:string; execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ details: unknown; content: Array<{type:string; text?:string}> }> };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Listed = { pending:AgentMessage[]; inbox:InboxStatus };

// Only the extension host facade is supplied here. Native IPC, ConversationBook,
// BatchInbox and actual agent-core queue objects are the real implementations.
test("real IPC finals and requests use one inbox wake and exact model-tool correlation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bus-batch-extension-"));
  const oldDir = process.env.OMP_SESSION_BUS_DIR;
  const oldRoot = process.env.OMP_SESSION_BUS_PROJECT_ROOT;
  process.env.OMP_SESSION_BUS_DIR = join(directory, "ipc");
  delete process.env.OMP_SESSION_BUS_PROJECT_ROOT;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const persisted: Array<{type:string; data:unknown}> = [];
  const directMessages: unknown[] = [];
  class Owner {
    isStreaming = true;
    sessionManager = { getSessionId: () => "batch-extension-session" };
    agent = new Agent();
    async promptCustomMessage(payload: Parameters<QueuedPromptHost["promptCustomMessage"]>[0], options: Parameters<QueuedPromptHost["promptCustomMessage"]>[1]) {
      await Promise.resolve(); // The real host normalizes asynchronously.
      expect(options?.queueOnly).toBe(true);
      const message = {...payload, role:"custom" as const, timestamp:Date.now()};
      this.agent.followUp(message);
      options?.onPromptQueued?.([message]);
      return true;
    }
  }
  const owner = new Owner();
  // Minimal in-process host facade; native peer and queue implementations remain real.
  const ctx = { cwd:directory, agent:{id:"main",kind:"main"}, sessionManager:owner.sessionManager, hasUI:false,
    isIdle:()=>!owner.isStreaming, ui:{notify:()=>{},setStatus:()=>{}},setTimeout:()=>{} } as unknown as ExtensionContext;
  const api = {
    typebox,
    pi:{AgentSession:Owner,AgentRegistry:{global:()=>({get:()=>({session:owner})})}},
    registerTool:(tool:Tool)=>tools.set(tool.name,tool),registerCommand:()=>{},
    on:(name:string,handler:Handler)=>handlers.set(name,handler),
    appendEntry:(type:string,data:unknown)=>persisted.push({type,data}),
    sendMessage:(...args:unknown[])=>directMessages.push(args),logger:{error:()=>{}},
  } as unknown as ExtensionAPI;
  let remote:LocalPeer|undefined;
  try {
    sessionBus(api);
    await handlers.get("session_start")!({},ctx);
    const invoke = async (name:string,params:unknown={}) => (await tools.get(name)!.execute("test",params,undefined,undefined,ctx)).details;
    const self=(await invoke("session_identity") as {self:PeerInfo}).self;
    let remoteBook:ConversationBook;
    const received:AgentMessage[]=[];
    remote=await LocalPeer.start({rootDir:process.env.OMP_SESSION_BUS_DIR,metadata:{cwd:directory,sessionId:"other",projectId:self.projectId,projectName:self.projectName},getState:()=>"idle",onMessage:message=>{remoteBook.receive(message);received.push(message);}});
    remoteBook=new ConversationBook(remote.agentId,self.projectId);
    const sentFinals:AgentMessage[]=[];
    for(let index=0;index<20;index++) {
      await invoke("session_send",{to:remote.agentId,text:`Independent request ${index}`,maxTurns:2});
      const request=received.at(-1)!;
      const final=remoteBook.reply(request.messageId,`Exact final ${index}`,true);
      sentFinals.push(final);
      await remote.send(final);
    }
    const request=remoteBook.start(self.agentId,"One actual reply-required item");
    await remote.send(request);
    expect(owner.agent.getFollowUpMode()).toBe("one-at-a-time");
    expect(owner.agent.peekFollowUpQueue()).toHaveLength(1);
    expect(directMessages).toEqual([]); // No terminal per-message triggerTurn path.
    const state=await invoke("session_list") as Listed;
    expect(state.pending.map(m=>m.messageId)).toEqual([request.messageId]);
    expect(state.inbox.unread).toBe(21);
    const page=await invoke("session_inbox",{action:"read"}) as InboxPage;
    expect(page.total).toBe(21);
    expect(page.nextOffset).toBeNull();
    expect(page.entries.map(entry=>entry.message)).toEqual([...sentFinals,request]);
    expect(page.entries.map(entry=>entry.sequence)).toEqual(Array.from({length:21},(_,i)=>i+1));
    expect(owner.agent.peekFollowUpQueue()).toEqual([]);
    await expect(invoke("session_inbox",{action:"complete",batchId:page.batchId})).rejects.toThrow();
    await invoke("session_reply",{replyTo:request.messageId,text:"Exact single reply",done:true});
    expect(received.at(-1)?.inReplyTo).toBe(request.messageId);
    expect((await invoke("session_inbox",{action:"read",batchId:page.batchId}) as InboxPage).entries.at(-1)?.requiresReply).toBe(false);
    await invoke("session_inbox",{action:"complete",batchId:page.batchId});
    expect((await invoke("session_list") as Listed).inbox.unread).toBe(0);
    expect(owner.agent.peekFollowUpQueue()).toEqual([]);
    expect(persisted.filter(entry=>entry.type==="session-bus-final-delivery")).toHaveLength(20);
    // Exercise the actual registered serializer, not only details or core pages.
    const large: AgentMessage[] = [];
    for (let index=0; index<8; index++) {
      await invoke("session_send",{to:remote.agentId,text:`Large original ${index}`,maxTurns:2});
      const final=remoteBook.reply(received.at(-1)!.messageId,"x".repeat(130_000),true);
      large.push(final);await remote.send(final);
    }
    let raw=await tools.get("session_inbox")!.execute("size",{action:"read"},undefined,undefined,ctx);
    const actual: AgentMessage[]=[];
    while (true) {
      const result=raw.details as InboxPage;
      expect(raw.content[0].text).toBe(JSON.stringify(result));
      expect(Buffer.byteLength(raw.content[0].text!,"utf8")).toBeLessThanOrEqual(1024*1024);
      actual.push(...result.entries.map(entry=>entry.message));
      if(result.nextOffset===null){await invoke("session_inbox",{action:"complete",batchId:result.batchId});break;}
      raw=await tools.get("session_inbox")!.execute("size",{action:"read",batchId:result.batchId,offset:result.nextOffset},undefined,undefined,ctx);
    }
    expect(actual).toEqual(large);
  } finally {
    await remote?.close();
    await handlers.get("session_shutdown")?.({},ctx);
    if(oldDir===undefined)delete process.env.OMP_SESSION_BUS_DIR;else process.env.OMP_SESSION_BUS_DIR=oldDir;
    if(oldRoot===undefined)delete process.env.OMP_SESSION_BUS_PROJECT_ROOT;else process.env.OMP_SESSION_BUS_PROJECT_ROOT=oldRoot;
    await rm(directory,{recursive:true,force:true});
  }
});
