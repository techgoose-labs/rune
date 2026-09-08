// Hand-written in the rune-manifest output style (no members.rune): the producer side of the
// cross-module contract. Its one endpoint outputs `memberId` — the same field name checkout
// declares as the external input `$memberId` — so composing the two modules snaps the contract
// together with no seeds: keep orders `create` before checkout's `start` (synthetic edge) and
// the emulator shows the `auto:` affordance on checkout's module-inputs card.

import {
  Endpoint,
  EndpointController,
  endpointModule,
} from "@techgoose-labs/rune";
import { JoinDto } from "@/src/members/dto/join.ts";
import { MemberDto } from "@/src/members/dto/member.ts";

@EndpointController("members")
export class MembersController {
  @Endpoint({ path: "create", input: JoinDto, output: MemberDto, order: 1 })
  create(body: JoinDto): MemberDto {
    // Deterministic: the composed e2e stages assert on the "member-" prefix.
    return { memberId: "member-" + (body?.alias || "anon") };
  }
}

export const membersModule = endpointModule("Members", [MembersController]);
