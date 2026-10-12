import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dispatchAction, queueAction, useOpenPaletteListener, type AppAction } from "@/lib/app-events";
import {
  SHORTCUTS,
  formatKeys,
  isPaletteKey,
  parseTaskKey,
  projectKeyOfTask,
  shortcutKeys,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useShortcuts } from "@/lib/use-shortcuts";
import { useSignOut } from "@/lib/use-sign-out";
import { documentsQuery, projectsQuery, tasksQuery } from "@/lib/work";
import type { MeResponse } from "@repo/core/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  BotIcon,
  CornerDownRightIcon,
  FileTextIcon,
  FolderCogIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  FolderIcon,
  HomeIcon,
  KeyboardIcon,
  KanbanIcon,
  ListIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const MAX_TASKS = 100;

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export const paletteHint = () =>
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform) ? "⌘K" : "Ctrl K";

function Hint({ id }: { id: ShortcutId }) {
  return <CommandShortcut>{formatKeys(shortcutKeys(id))}</CommandShortcut>;
}

/** Command palette (Cmd/Ctrl+K), the global keyboard shortcuts and their help dialog (ST-16). Mounted once for signed-in pages. */
export function CommandPalette({ me }: { me: MeResponse }) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const signOut = useSignOut();
  const { theme = "system", setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState("");
  // When set, the palette lists projects to choose where the new task or document goes.
  const [pick, setPick] = useState<AppAction | null>(null);

  const orgSlug = params.orgSlug ?? me.memberships[0]?.organization.slug;
  const membership = me.memberships.find((m) => m.organization.slug === orgSlug);
  const role = membership?.actor.role;
  const currentProject = params.projectKey ?? (params.taskKey ? projectKeyOfTask(params.taskKey) : undefined);

  const { data: projects = [] } = useQuery({ ...projectsQuery(orgSlug ?? ""), enabled: open && !!orgSlug });
  const { data: tasks = [] } = useQuery({
    ...tasksQuery(orgSlug ?? "", currentProject ?? ""),
    enabled: open && !!orgSlug && !!currentProject,
  });
  const { data: documents = [] } = useQuery({ ...documentsQuery(orgSlug ?? ""), enabled: open && !!orgSlug });

  const openPalette = () => {
    setPick(null);
    setSearch("");
    setOpen(true);
  };
  useOpenPaletteListener(openPalette);

  // Subscribe once; the latest state and handler are read through a ref.
  const paletteKey = useRef({ open, openPalette });
  paletteKey.current = { open, openPalette };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteKey(event)) return;
      event.preventDefault();
      if (paletteKey.current.open) setOpen(false);
      else paletteKey.current.openPalette();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const close = () => setOpen(false);

  const goProject = (projectKey: string, view?: "board" | "list" | "docs") => {
    if (!orgSlug) return;
    void navigate({
      to: "/$orgSlug/projects/$projectKey",
      params: { orgSlug, projectKey },
      search: view ? { view } : {},
    });
  };

  /** New task or document: in `projectKey`, else the current project, else ask which project. */
  const startAction = (action: AppAction, projectKey?: string) => {
    if (!orgSlug) return;
    if (action === "new-document" && !projectKey) {
      // Documents can also be organization-wide; the project page (project-scoped) or the docs page (org-wide) opens the dialog.
      if (params.projectKey) return dispatchAction(action);
      queueAction(action);
      return void navigate({ to: "/$orgSlug/docs", params: { orgSlug } });
    }
    const target = projectKey ?? currentProject ?? (projects.length === 1 ? projects[0]?.key : undefined);
    if (!target) {
      if (projects.length === 0) return void toast.error("Create a project first.");
      setPick(action);
      setSearch("");
      return setOpen(true);
    }
    if (params.projectKey === target) return dispatchAction(action);
    queueAction(action);
    goProject(target);
  };

  useShortcuts((id) => {
    switch (id) {
      case "new-task":
        startAction("new-task");
        return true;
      case "go-board":
      case "go-list":
      case "go-docs": {
        const view = id === "go-board" ? "board" : id === "go-list" ? "list" : "docs";
        if (currentProject) goProject(currentProject, view);
        else if (orgSlug) void navigate({ to: "/$orgSlug", params: { orgSlug } });
        return true;
      }
      case "go-projects":
        if (orgSlug) void navigate({ to: "/$orgSlug", params: { orgSlug } });
        else void navigate({ to: "/" });
        return true;
      case "focus-search": {
        const input = document.querySelector<HTMLInputElement>('[role="search"] input');
        if (!input || input.offsetParent === null) return false;
        input.focus();
        return true;
      }
      case "help":
        setHelpOpen(true);
        return true;
      case "edit-title": {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
        if (!input || input.readOnly) return false;
        input.focus();
        input.select();
        return true;
      }
      case "assign": {
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Assignees"]');
        // The task page renders its fields twice (side column and phone layout); click the visible one.
        const visible = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Assignees"]')].find(
          (b) => b.offsetParent !== null,
        );
        const target = visible ?? button;
        if (!target) return false;
        target.click();
        return true;
      }
    }
  });

  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const typedKey = parseTaskKey(search);
  const trimmed = search.trim();
  const shownTasks = useMemo(() => (trimmed ? tasks.slice(0, MAX_TASKS) : []), [tasks, trimmed]);
  const goTask = (taskKey: string) => {
    if (orgSlug) void navigate({ to: "/$orgSlug/tasks/$taskKey", params: { orgSlug, taskKey } });
  };

  const canManage = role === "owner" || role === "admin";
  const canCreateTasks = role !== undefined && role !== "guest";
  const themes = [
    { value: "system", label: "System", Icon: MonitorIcon },
    { value: "light", label: "Light", Icon: SunIcon },
    { value: "dark", label: "Dark", Icon: MoonIcon },
  ] as const;

  const projectItems = (onSelect: (key: string) => void) =>
    projects.map((p) => (
      <CommandItem key={p.id} value={`project ${p.key} ${p.name}`} onSelect={() => onSelect(p.key)}>
        <FolderIcon />
        <span className="truncate">{p.name}</span>
        <CommandShortcut>{p.key}</CommandShortcut>
      </CommandItem>
    ));

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search projects, tasks and documents, or run a command."
      >
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={pick ? "Choose a project…" : "Search or run a command…"}
          />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            {pick ? (
              <CommandGroup heading={pick === "new-task" ? "New task in…" : "New document in…"}>
                {projectItems((key) => {
                  close();
                  startAction(pick, key);
                })}
              </CommandGroup>
            ) : (
              <>
                {typedKey && !tasks.some((t) => t.key === typedKey) && (
                  <CommandGroup heading="Go to">
                    <CommandItem value={`go to task ${typedKey}`} onSelect={run(() => goTask(typedKey))}>
                      <CornerDownRightIcon />
                      Go to {typedKey}
                    </CommandItem>
                  </CommandGroup>
                )}
                {shownTasks.length > 0 && (
                  <CommandGroup heading={`Tasks in ${currentProject}`}>
                    {shownTasks.map((t) => (
                      <CommandItem key={t.id} value={`task ${t.key} ${t.title}`} onSelect={run(() => goTask(t.key))}>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t.key}</span>
                        <span className="truncate">{t.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandGroup heading="Actions">
                  {canCreateTasks && (
                    <CommandItem value="action new task create" onSelect={run(() => startAction("new-task"))}>
                      <PlusIcon />
                      New task{currentProject ? ` in ${currentProject}` : ""}
                      <Hint id="new-task" />
                    </CommandItem>
                  )}
                  {canCreateTasks && (
                    <CommandItem value="action new document create" onSelect={run(() => startAction("new-document"))}>
                      <FileTextIcon />
                      New document
                    </CommandItem>
                  )}
                  {themes.map(({ value, label, Icon }) => (
                    <CommandItem
                      key={value}
                      value={`action theme ${label}`}
                      keywords={["appearance", "dark", "light", "mode"]}
                      onSelect={run(() => setTheme(value))}
                    >
                      <Icon />
                      Theme: {label}
                      {theme === value && <CommandShortcut>current</CommandShortcut>}
                    </CommandItem>
                  ))}
                  <CommandItem value="action keyboard shortcuts help" onSelect={run(() => setHelpOpen(true))}>
                    <KeyboardIcon />
                    Keyboard shortcuts
                    <Hint id="help" />
                  </CommandItem>
                  <CommandItem value="action sign out log out" onSelect={run(() => void signOut())}>
                    <LogOutIcon />
                    Sign out
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                {projects.length > 0 && <CommandGroup heading="Projects">{projectItems((key) => {
                  close();
                  goProject(key);
                })}</CommandGroup>}
                {currentProject && orgSlug && (
                  <CommandGroup heading={currentProject}>
                    <CommandItem value={`${currentProject} board`} onSelect={run(() => goProject(currentProject, "board"))}>
                      <KanbanIcon />
                      Board
                      <Hint id="go-board" />
                    </CommandItem>
                    <CommandItem value={`${currentProject} list`} onSelect={run(() => goProject(currentProject, "list"))}>
                      <ListIcon />
                      List
                      <Hint id="go-list" />
                    </CommandItem>
                    <CommandItem value={`${currentProject} documents`} onSelect={run(() => goProject(currentProject, "docs"))}>
                      <FileTextIcon />
                      Documents
                      <Hint id="go-docs" />
                    </CommandItem>
                  </CommandGroup>
                )}
                {documents.length > 0 && orgSlug && (
                  <CommandGroup heading="Documents">
                    {documents.slice(0, MAX_TASKS).map((d) => (
                      <CommandItem
                        key={d.id}
                        value={`document ${d.title} ${d.projectKey ?? ""} ${d.taskKey ?? ""} ${d.id}`}
                        onSelect={run(
                          () => void navigate({ to: "/$orgSlug/docs/$documentId", params: { orgSlug, documentId: d.id } }),
                        )}
                      >
                        <FileTextIcon />
                        <span className="truncate">{d.title}</span>
                        {(d.taskKey ?? d.projectKey) && <CommandShortcut>{d.taskKey ?? d.projectKey}</CommandShortcut>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {orgSlug && (
                  <CommandGroup heading="Go to">
                    <CommandItem
                      value="go home projects"
                      onSelect={run(() => void navigate({ to: "/$orgSlug", params: { orgSlug } }))}
                    >
                      <HomeIcon />
                      Projects (home)
                      <Hint id="go-projects" />
                    </CommandItem>
                    <CommandItem
                      value="go docs documents all"
                      onSelect={run(() => void navigate({ to: "/$orgSlug/docs", params: { orgSlug } }))}
                    >
                      <FileTextIcon />
                      All documents
                    </CommandItem>
                    <CommandItem
                      value="go settings members"
                      onSelect={run(() => void navigate({ to: "/$orgSlug/settings/members", params: { orgSlug } }))}
                    >
                      <UsersIcon />
                      Settings: Members
                    </CommandItem>
                    {canManage && (
                      <CommandItem
                        value="go settings projects"
                        onSelect={run(() => void navigate({ to: "/$orgSlug/settings/projects", params: { orgSlug } }))}
                      >
                        <FolderCogIcon />
                        Settings: Projects
                      </CommandItem>
                    )}
                    <CommandItem
                      value="go settings repos"
                      onSelect={run(() => void navigate({ to: "/$orgSlug/settings/repos", params: { orgSlug } }))}
                    >
                      <GitBranchIcon />
                      Settings: Repos
                    </CommandItem>
                    <CommandItem
                      value="go settings github"
                      onSelect={run(() => void navigate({ to: "/$orgSlug/settings/github", params: { orgSlug } }))}
                    >
                      <GitPullRequestIcon />
                      Settings: GitHub
                    </CommandItem>
                    {canCreateTasks && (
                      <CommandItem
                        value="go settings agents"
                        onSelect={run(() => void navigate({ to: "/$orgSlug/settings/agents", params: { orgSlug } }))}
                      >
                        <BotIcon />
                        Settings: Agents
                      </CommandItem>
                    )}
                    <CommandItem value="go account" onSelect={run(() => void navigate({ to: "/account" }))}>
                      <UserIcon />
                      Account
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}

function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const groups = ["General", "Go to", "Task page"] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts are off while you type or while a dialog is open.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <section aria-label="Command palette">
            <ul>
              <ShortcutRow label="Command palette" keys={[paletteHint()]} />
            </ul>
          </section>
          {groups.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group}</h3>
              <ul className="flex flex-col gap-1">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <ShortcutRow key={s.id} label={s.label} keys={s.keys} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: readonly string[] }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-xs text-muted-foreground">then</span>}
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
          </span>
        ))}
      </span>
    </li>
  );
}
