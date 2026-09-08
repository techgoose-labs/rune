import "#reflect-metadata";
import { assertEquals, assertExists, assertThrows } from "#assert";
import { ApiProperty } from "#danet/swagger/decorators";
import {
  getWsProcessMetadata,
  WsEndpoint,
  WsEndpointController,
} from "./mod.ts";

// reflect-metadata augments the global Reflect at runtime; surface the two methods we read.
const reflectMeta = Reflect as unknown as {
  getMetadata(key: string, target: unknown, propertyKey?: string): unknown;
};

class ChatDto {
  @ApiProperty()
  text!: string;
}
class EchoDto {
  @ApiProperty()
  text!: string;
}

@WsEndpointController("rooms/:room")
class ChatSocket {
  @WsEndpoint({ topic: "send", input: ChatDto, output: EchoDto })
  send(data: ChatDto): EchoDto {
    return { text: data.text };
  }

  @WsEndpoint({ topic: "leave", input: ChatDto })
  leave(_data: ChatDto): void {}
}

Deno.test("WsEndpointController stamps danet's websocket-endpoint on the class", () => {
  // danet's bootstrap routes a controller to the WebSocket transport iff this metadata is truthy.
  assertEquals(
    reflectMeta.getMetadata("websocket-endpoint", ChatSocket),
    "rooms/:room",
  );
});

Deno.test("WsEndpoint stamps danet's websocket-topic on the handler method", () => {
  // SetMetadata writes the topic onto the method function (descriptor.value) — exactly what
  // danet's WebSocketRouter reads via getMetadata('websocket-topic', controllerMethod).
  assertEquals(
    reflectMeta.getMetadata("websocket-topic", ChatSocket.prototype.send),
    "send",
  );
  assertEquals(
    reflectMeta.getMetadata("websocket-topic", ChatSocket.prototype.leave),
    "leave",
  );
});

Deno.test("WsEndpoint records lightweight ws process metadata", () => {
  const send = getWsProcessMetadata(ChatSocket.prototype, "send");
  assertExists(send);
  assertEquals(send, { kind: "ws", topic: "send" });
});

Deno.test("WsEndpointController rejects an empty path (would silently route to HTTP)", () => {
  assertThrows(() => WsEndpointController(""), Error, "non-empty");
});
