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
import { useCreateProject } from "@/lib/work";
import { createProjectInput } from "@repo/core/schemas";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

/** "Spider Tracker" → "ST", "Website" → "WEB". */
function suggestKey(name: string) {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const key =
    words.length > 1
      ? words.map((w) => w[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return key.replace(/^[0-9]+/, "").slice(0, 10);
}

export function NewProjectDialog({
  orgSlug,
  open,
  onOpenChange,
}: {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateProject(orgSlug);
  const navigate = useNavigate();

  function reset() {
    setName("");
    setKey("");
    setKeyEdited(false);
    setDescription("");
    setError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createProjectInput.safeParse({
      name,
      key,
      description: description || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: async (project) => {
        onOpenChange(false);
        reset();
        await navigate({
          to: "/$orgSlug/projects/$projectKey",
          params: { orgSlug, projectKey: project.key },
        });
      },
      onError: (err) => setError(err.message),
    });
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
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Tasks in this project are numbered with its key, like SPI-12.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_8rem] gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!keyEdited) setKey(suggestKey(e.target.value));
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="project-key">Key</Label>
              <Input
                id="project-key"
                value={key}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value.toUpperCase());
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
