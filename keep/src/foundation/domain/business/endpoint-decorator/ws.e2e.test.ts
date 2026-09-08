import "#reflect-metadata";
import { assertEquals } from "#assert";
import { IsNumber, IsString } from "class-validator";
import { DanetApplication } from "#danet/core";
import { endpointModule, WsEndpoint, WsEndpointController } from "./mod.ts";

// A WS controller written exactly as `rune manifest` generates one for an `[ENT:ws]` socket.
// DTO fields carry class-validator decorators (as renderDto emits) so `assert` validates them.
class ChatDto {
  @IsString()
  text!: string;
}
class EchoDto {
  @IsString()
  text!: string;
  @IsNumber()
  at!: number;
}

@WsEndpointController("rooms/:room")
class ChatSocket {
  @WsEndpoint({ topic: "send", input: ChatDto, output: EchoDto })
  send(data: ChatDto): EchoDto {
    return { text: data.text, at: 7 };
  }
}

const ChatModule = endpointModule("Chat", [ChatSocket]);

// Sanitizers off: the WebSocket client + Deno.serve teardown are async and would otherwise
// trip false-positive resource/op leak detection. The server is still closed in `finally`.
Deno.test({
  name:
    "WS e2e — real socket upgrades, routes the topic, validates the payload, replies to the sender",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const app = new DanetApplication();
  await app.init(ChatModule);
  const { port } = await app.listen(0);
  const ws = new WebSocket(`ws://localhost:${port}/rooms/general`);
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for WS reply")),
        5000,
      );
      ws.onopen = () =>
        ws.send(JSON.stringify({ topic: "send", data: { text: "hi" } }));
      ws.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data as string);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WS connection error"));
      };
    });
    // The handshake upgraded at /rooms/:room, the "send" topic dispatched to the handler,
    // ChatDto validated, and the returned EchoDto was sent back to this sender.
    assertEquals(JSON.parse(reply), { text: "hi", at: 7 });
  } finally {
    ws.close();
    await app.close();
  }
});
