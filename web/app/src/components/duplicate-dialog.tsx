import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMarkDuplicate } from "@/lib/work";
import { markDuplicateInput } from "@repo/core/schemas";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

/** "Duplicate of…" (ST-114): links the task to the original, cancels it and comments, in one step. */
export function DuplicateDialog({
  orgSlug,
  taskKey,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  taskKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [of, setOf] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mark = useMarkDuplicate(orgSlug);

  function reset() {
    setOf("");
    setComment("");
    setError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = markDuplicateInput.safeParse({ of: of.trim().toUpperCase(), comment: comment.trim() || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    mark.mutate(
      { taskKey, input: parsed.data },
      {
        onSuccess: () => {
          toast.success(`${taskKey} marked as a duplicate of ${parsed.data.of}`);
          onOpenChange(false);
          reset();
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Duplicate of…</DialogTitle>
            <DialogDescription>
              Links {taskKey} to the original, moves it to Canceled and leaves a comment naming the original.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-of">Original task</Label>
            <Input
              id="duplicate-of"
              autoFocus
              placeholder="Task key, e.g. ST-12"
              value={of}
              onChange={(e) => setOf(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="duplicate-comment">Comment (optional)</Label>
            <Textarea id="duplicate-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={mark.isPending || !of.trim()}>
              {mark.isPending ? "Marking…" : "Mark as duplicate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
