import { AvatarStack } from "@/components/avatar-stack";
import { useWorkingNow } from "@/lib/use-presence";
import type { ActorDto } from "@repo/core/contracts";
import type { ComponentProps } from "react";

/** A task's assignees; agents working on it right now get an emerald ring and a pulsing dot (ST-67). */
export function WorkingAvatars({
  orgSlug,
  taskKey,
  ...props
}: { orgSlug: string; taskKey: string } & ComponentProps<typeof AvatarStack>) {
  const working = useWorkingNow(orgSlug, taskKey);
  return (
    <AvatarStack
      {...props}
      isWorking={(a: ActorDto) => working.includes(a.id)}
      highlight={(a: ActorDto) =>
        working.includes(a.id) ? "ring-emerald-500" : undefined
      }
    />
  );
}
