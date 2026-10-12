// Response shapes of the public API, shared with clients.

import type { ViewFilters } from "./schemas";

export type ActorRole = "owner" | "admin" | "member" | "guest";

export interface OrganizationDto {
  id: string;
  slug: string;
  name: string;
}

/** "integration": a per-organization bot, e.g. the GitHub one (ST-82); listed only with `?all=true`. */
export type ActorType = "human" | "agent" | "integration";

export interface ActorDto {
  id: string;
  type: ActorType;
  name: string;
  handle: string;
  avatarUrl: string | null;
  role: ActorRole;
  /** Deactivated people and deleted agents; only listed by `GET /members?all=true` and kept as task assignees. */
  deactivated: boolean;
  /** For agents, the actor id of the person who owns them (deleted agents too); null for people. */
  ownerId: string | null;
}

export interface MembershipDto {
  organization: OrganizationDto;
  actor: ActorDto;
}

export interface MeResponse {
  user: { id: string; name: string; email: string; image: string | null };
  memberships: MembershipDto[];
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type AuthProvider = "magic-link" | "github" | "batele-id";

export interface AuthProvidersResponse {
  providers: AuthProvider[];
}

export type StatusCategory = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";

/** What a task is (ST-90): ordinary work, a release (ST-93) or a milestone (ST-96); each kind has its own workflow. */
export type TaskKind = "task" | "release" | "milestone";

export interface StatusDto {
  id: string;
  /** The workflow it belongs to (ST-90); servers from before it send none (read it as "task"). */
  kind: TaskKind;
  name: string;
  category: StatusCategory;
  color: string | null;
  /** Board order within its kind's workflow, from 0. */
  position: number;
}

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
  /** Archived projects are left out of lists and refuse new tasks. */
  archivedAt: string | null;
  /** The project's rules for agents (ST-111): one of its project-level documents, or null. */
  rulesDocumentId: string | null;
  /** The web page's address (ST-115); set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

export interface ProjectDetailDto extends ProjectDto {
  /** The workflow of ordinary tasks (kind "task"), in board order, as before kinds (ST-90). */
  statuses: StatusDto[];
  /** Every kind's workflow, in board order (ST-90); servers from before it send none (see workflowOf). */
  workflows: Record<TaskKind, StatusDto[]>;
}

/** A deleted status (ST-90): the project afterwards and how many tasks moved to the target status. */
export interface DeleteStatusResponse {
  project: ProjectDetailDto;
  movedTasks: number;
}

/** A project's rules for agents (ST-111): its rules document, with content. */
export interface ProjectRulesDto {
  projectKey: string;
  projectName: string;
  documentId: string;
  title: string;
  format: "md" | "html";
  version: number;
  updatedAt: string;
  content: string;
}

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface TaskDto {
  id: string;
  key: string;
  number: number;
  projectId: string;
  /** Fixed at creation (ST-90); its status is one of its project's statuses of this kind. */
  kind: TaskKind;
  title: string;
  description: string | null;
  statusId: string;
  priority: Priority;
  parentId: string | null;
  /** The parent's key, e.g. "ST-3", when parentId is set. */
  parentKey: string | null;
  sortKey: string;
  /** Plan dates (ST-91), "YYYY-MM-DD" or null; start ≤ target. */
  startDate: string | null;
  targetDate: string | null;
  assigneeIds: string[];
  tagIds: string[];
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Direct sub-tasks the viewer can see (closed = done or canceled); null when there are none. */
  subtasks: { done: number; total: number } | null;
  /**
   * The release (a task of kind "release") this task ships in (ST-93); null when in none, or when
   * the release is in a project the viewer can't see.
   */
  releaseId: string | null;
  /** When its release was marked Released (for a release: when it was); null until then. */
  shippedAt: string | null;
  /** Marked as having no code to ship: a Done task that never needs a release. */
  noCode: boolean;
  /**
   * Where a task's code is (ST-93; Done means finished, not shipped). Null for releases and
   * milestones, and for tasks that aren't Done and are in no release.
   */
  shipping: TaskShippingDto | null;
  /**
   * The milestone this task was put in itself (ST-96), in its own project; null when none (a
   * sub-task may still inherit its parent's, see `milestone`).
   */
  milestoneId: string | null;
  /**
   * The milestone the task belongs to (ST-96): its own, else the nearest ancestor's (`inherited`).
   * Null when in none, for releases and milestones, or when the milestone is in a project the viewer can't see.
   */
  milestone: MilestoneRefDto | null;
  /** The web page's address (ST-115); set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

/**
 * A Done task's shipping state (ST-93): `not_in_release` (it has code that no release ships yet),
 * `in_release` (in a release on its way: Planned, On staging, Release review), `shipped` (its
 * release is Released) or `no_code` (marked as having nothing to ship).
 */
export type ShippingState = "not_in_release" | "in_release" | "shipped" | "no_code";

/** A release as a task's shipping state names it. */
export interface ReleaseRefDto {
  id: string;
  key: string;
  /** The release's name, usually its version ("2026.10.13"). */
  title: string;
  status: Pick<StatusDto, "id" | "name" | "category">;
}

export interface TaskShippingDto {
  state: ShippingState;
  /** The release it is in; null when in none, or in one the viewer can't see. */
  release: ReleaseRefDto | null;
}

/** A milestone as a task names it (ST-96). */
export interface MilestoneRefDto {
  id: string;
  key: string;
  title: string;
  status: Pick<StatusDto, "id" | "name" | "category">;
  /** Taken from an ancestor: the task has no milestone of its own. */
  inherited: boolean;
}

/** What a bulk update did to one task (ST-106); in a dry run, "changed" means it would change. */
export type BulkTaskOutcome = "changed" | "unchanged" | "error";

export interface BulkTaskResultDto {
  /** The task's key; for an error, the key as given (normalized when it parses). */
  key: string;
  outcome: BulkTaskOutcome;
  /** The task after the change (as it would be, in a dry run); null on error. */
  task: TaskDto | null;
  /** Why this task wasn't changed: a domain error code ("not_found", "validation", …) and message. */
  error: { code: string; message: string } | null;
}

export interface BulkUpdateTasksResponse {
  dryRun: boolean;
  summary: { changed: number; unchanged: number; failed: number };
  /** One per task, in the order of the keys given or, for a filter, in board order. */
  results: BulkTaskResultDto[];
}

/** An agent working on a task right now (ST-67): it acted on or read the task within the last 10 minutes. */
export interface PresenceDto {
  taskKey: string;
  actorId: string;
  /** ISO time of the agent's latest action or read. */
  lastSeenAt: string;
}

/** A sub-task with its own status, which may belong to another project than the parent's. */
export interface SubtaskDto extends TaskDto {
  status: Pick<StatusDto, "id" | "name" | "category" | "color">;
}

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
}

/** How an app's releases are numbered (ST-92): "2026.10.12" or "1.4.0". */
export type AppVersioning = "date" | "semver";

/** A deployable part of a repo (ST-92). */
export interface AppDto {
  id: string;
  repoId: string;
  /** The repo's "owner/name". */
  repo: string;
  /** Lower-case, e.g. "web". */
  name: string;
  /** Its folder in the repo, e.g. "web/app" ("." for the whole repo). */
  path: string;
  /** Shared packages it depends on, e.g. ["packages/core"]. */
  sharedPaths: string[];
  versioning: AppVersioning;
  /** Deploy order, e.g. ["staging", "prod"]; empty when there is nothing to deploy (a CLI). */
  environments: string[];
  createdAt: string;
}

/** A git repo of the organization (ST-92), attached to projects, with its apps. */
export interface RepoDto {
  id: string;
  owner: string;
  name: string;
  /** "owner/name". */
  fullName: string;
  defaultBranch: string;
  /** Set once the GitHub App is installed on the repo (ST-82); null for repos added by URL. */
  githubInstallationId: number | null;
  /** Keys of the projects it is attached to (those the caller can see), sorted. */
  projects: string[];
  /** By name. */
  apps: AppDto[];
  createdAt: string;
}

/** An app a release ships (ST-93), with the version it ships. */
export interface ReleaseAppDto {
  appId: string;
  /** The repo's "owner/name". */
  repo: string;
  /** The app's name, e.g. "web". */
  name: string;
  versioning: AppVersioning;
  environments: string[];
  /** "2026.10.13" (date) or "0.1.8" (semver). */
  version: string;
}

/** A task a release includes (ST-93). */
export interface ReleaseTaskDto {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  status: Pick<StatusDto, "id" | "name" | "category">;
  completedAt: string | null;
  shippedAt: string | null;
  /** The web page's address; set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

/**
 * A release (ST-93): a task of kind "release" with its status, the repos and apps (a version each)
 * it ships, and the Done tasks it includes, from any project. A project-scoped agent sees only the
 * included tasks of its own projects.
 */
export interface ReleaseDto extends TaskDto {
  status: Pick<StatusDto, "id" | "name" | "category">;
  repos: { id: string; fullName: string }[];
  /** By repo, then name. */
  apps: ReleaseAppDto[];
  /** By project key, then number. */
  tasks: ReleaseTaskDto[];
}

/**
 * A milestone's progress (ST-96), over its tasks the viewer can see: its own tasks and their
 * sub-tasks that have no milestone of their own. Canceled tasks are left out of `total`.
 */
export interface MilestoneProgressDto {
  /** Its tasks that aren't canceled. */
  total: number;
  /** Of those, the ones in a done status. */
  done: number;
  /** Canceled tasks (not part of `total`). */
  canceled: number;
  /** Of the done ones, those with code to ship (not marked no code). */
  withCode: number;
  /** Of the done ones with code, those whose release is Released. */
  shipped: number;
  /** Every task Done and all their code shipped (and at least one task): ready to close. */
  complete: boolean;
}

/** A task of a milestone (ST-96). */
export interface MilestoneTaskDto {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  status: Pick<StatusDto, "id" | "name" | "category">;
  /** Its parent's key when it is a sub-task. */
  parentKey: string | null;
  /** In the milestone through an ancestor, not by its own `milestoneId`. */
  inherited: boolean;
  completedAt: string | null;
  /** Where a Done task's code is, as on TaskDto. */
  shipping: TaskShippingDto | null;
  /** The web page's address; set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

/** A release that ships some of a milestone's tasks (ST-96): what moved it forward. */
export interface MilestoneReleaseDto {
  id: string;
  key: string;
  /** Its name, usually the version. */
  title: string;
  status: Pick<StatusDto, "id" | "name" | "category">;
  /** When it was marked Released; null while on its way. */
  shippedAt: string | null;
  /** Keys of the milestone's tasks it includes. */
  tasks: string[];
}

/**
 * A milestone (ST-96): a task of kind "milestone" (goal and "Done when" in its description, start
 * and target dates) with its status, progress, tasks and the releases that shipped them.
 */
export interface MilestoneDto extends TaskDto {
  status: Pick<StatusDto, "id" | "name" | "category">;
  progress: MilestoneProgressDto;
  /** By project key, then number. */
  tasks: MilestoneTaskDto[];
  /** Released ones first, oldest first; then those on their way. */
  releases: MilestoneReleaseDto[];
}

/** A task in a release's changelog (ST-95): its title and the "What changed" part of its handoff note. */
export interface ReleaseChangelogEntryDto {
  key: string;
  title: string;
  projectKey: string;
  /** The "What changed" section of the task's handoff note (Markdown); null when none was found. */
  whatChanged: string | null;
  /** The comment it was taken from. */
  handoff: { commentId: string; authorId: string; createdAt: string } | null;
  /** Names of the release's apps the task touches; empty when unknown (see `grouped`). */
  apps: string[];
  /** The web page's address; set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

/** How the changelog block in a release's description compares with the generated changelog. */
export type ChangelogState = "missing" | "current" | "outdated" | "edited";

/**
 * A release's changelog (ST-95), generated from its included tasks and grouped by app when it is
 * known which apps each task touches (a one-app release, or app names from the CLI's git scan).
 */
export interface ReleaseChangelogDto {
  release: { id: string; key: string; title: string; url?: string };
  /** The release's apps with their versions and git tags ("web-2026.10.13", "cli-v0.1.8"). */
  apps: { name: string; repo: string; version: string; tag: string }[];
  /** True when entries carry the apps they touch, so `markdown` has a section per app. */
  grouped: boolean;
  /** By project key, then number. */
  entries: ReleaseChangelogEntryDto[];
  /** The generated changelog (Markdown, a `###` section per app). */
  markdown: string;
  /** The changelog block in the release's description and how it compares with `markdown`. */
  description: { state: ChangelogState; content: string | null };
  /** What a write did to the description; null for a read. */
  written: "added" | "replaced" | "unchanged" | null;
}

/** One app's part of a release git check (ST-95). */
export interface ReleaseCheckAppDto {
  name: string;
  inRelease: boolean;
  /** The version the release ships; null when the app isn't in it. */
  version: string | null;
  /** The release's tag for the app ("web-2026.10.13"); null when the app isn't in it. */
  tag: string | null;
  /** The start of the range (exclusive): the previous tag, `--since`, or null for the whole history. */
  since: string | null;
  /** The end of the range: the release's tag when it exists, else the branch checked. */
  until: string;
  /** Commits in the range that touch the app's folder or shared paths. */
  commits: number;
  /** Task keys mentioned by those commits. */
  tasks: string[];
}

/**
 * `spider release check` (ST-95): the commits since each app's previous tag compared with the
 * release's tasks, from local git. `ok` is false when any of the three findings has something.
 */
export interface ReleaseCheckDto {
  release: { key: string; title: string };
  repo: string;
  ok: boolean;
  apps: ReleaseCheckAppDto[];
  /** Candidates (Done, with code, in no release) whose commits touch the release's apps. */
  leftOut: { key: string; title: string; apps: string[]; commits: string[] }[];
  /** Included tasks that no commit in the release apps' ranges mentions. */
  noCommits: { key: string; title: string }[];
  /** Apps of the repo changed since their previous tag that the release doesn't ship. */
  appsNotInRelease: { name: string; since: string | null; commits: number; tasks: string[] }[];
  /** The release's apps in other repos, not checked here. */
  skippedApps: { name: string; repo: string }[];
}

/** A GitHub App installation connected to the organization (ST-82). */
export interface GithubInstallationDto {
  /** GitHub's installation id. */
  id: number;
  /** The GitHub user or organization the App is installed on. */
  account: string;
  accountType: "User" | "Organization";
  /** Whether it grants every repository of the account or only selected ones. */
  repositorySelection: "all" | "selected";
  suspended: boolean;
  /** "owner/name" of the organization's repos it grants, sorted. */
  repos: string[];
  /** Where the installation is configured on GitHub (repository access, uninstall). */
  settingsUrl: string;
  /** Actor id of who connected it; null once they're gone. */
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /github`: whether the server has a GitHub App, and the organization's installations. */
export interface GithubStatusDto {
  /** False when the server has no `GITHUB_APP_*` settings: connecting and syncing are unavailable. */
  configured: boolean;
  /** The App's slug (github.com/apps/<slug>); null when not configured. */
  appSlug: string | null;
  installations: GithubInstallationDto[];
}

/**
 * How a task key was found in git (ST-84), strongest first: a closing keyword ("fixes ST-12"),
 * the branch name, the PR title, the PR body, a commit message.
 */
export type GitLinkVia = "closing" | "branch" | "title" | "body" | "message";

/** A branch whose name carries the task's key. */
export interface GitBranchDto {
  /** The repo's "owner/name". */
  repo: string;
  name: string;
  url: string;
  /** Deleted on GitHub since (after a merge, usually). */
  deleted: boolean;
  /** When it was first seen. */
  linkedAt: string;
}

/** A commit that mentions the task's key, or was pushed to its branch. */
export interface GitCommitDto {
  repo: string;
  sha: string;
  /** The first line of the message. */
  message: string;
  url: string;
  /** GitHub login, or the git author name. */
  author: string | null;
  committedAt: string | null;
  via: GitLinkVia;
}

/** "merged" is final; "closed" is closed without merging. */
export type PullRequestState = "open" | "closed" | "merged";

/** A pull request linked to the task by its branch, title or body. */
export interface PullRequestDto {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  /** GitHub login of who opened it. */
  author: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /** Its last change on GitHub. */
  updatedAt: string;
  via: GitLinkVia;
}

/** `GET /tasks/:key/git`: what is linked to the task in git (ST-84), most recent first. */
export interface TaskGitDto {
  taskKey: string;
  pullRequests: PullRequestDto[];
  branches: GitBranchDto[];
  /** The latest 100. */
  commits: GitCommitDto[];
}

/** `POST /github/install`: the GitHub page that installs the App; it returns to `/github/setup`. */
export interface GithubInstallUrlDto {
  url: string;
}

/** A saved filter set of a project's board or list (ST-15). */
export interface SavedViewDto {
  id: string;
  projectKey: string;
  ownerActorId: string;
  name: string;
  filters: ViewFilters;
  shared: boolean;
  view: "board" | "list";
  createdAt: string;
  updatedAt: string;
}

export interface ListResponse<T> {
  items: T[];
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned once, when a key is created: `secret` is never shown again. */
export interface CreatedApiKeyDto {
  key: ApiKeyDto;
  secret: string;
}

export interface AgentDto {
  actor: ActorDto;
  ownerId: string;
  /** The person the agent belongs to. */
  owner: { id: string; name: string; handle: string };
  description: string | null;
  /** Whether the caller may edit or delete it and manage its keys (its owner, or an owner/admin). */
  canManage: boolean;
  /** Key metadata; empty unless `canManage`. */
  keys: ApiKeyDto[];
  /** Projects the agent is limited to (empty once they are all deleted); null when it sees every project. */
  projects: ProjectRefDto[] | null;
}

export interface ProjectRefDto {
  key: string;
  name: string;
}

export type AgentInviteStatus = "pending" | "expired";

/** A one-time code an agent uses to set itself up (POST /v1/agent-invites/accept). */
export interface AgentInviteDto {
  id: string;
  /** Shown as ABCD-EFGH. */
  code: string;
  status: AgentInviteStatus;
  expiresAt: string;
  createdAt: string;
  createdBy: string | null;
  /** The pending agent, active once the code is accepted. */
  agent: { id: string; name: string; handle: string };
  projects: ProjectRefDto[];
}

export interface CreatedAgentInviteDto {
  invite: AgentInviteDto;
  agent: AgentInviteDto["agent"];
}

/** POST /v1/agent-invites/accept: the agent's first API key (shown once) and where it works. */
export interface AcceptedAgentInviteDto {
  token: string;
  actor: ActorDto;
  organization: OrganizationDto;
  projects: ProjectRefDto[];
  owner: { id: string; name: string; handle: string };
}

/** Who the current credentials act as (session user or API key). */
export interface WhoAmIResponse {
  actor: ActorDto;
  organization: OrganizationDto;
}

/** POST /device/code (RFC 8628 §3.2). */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** A pending `spider login`, as shown on the approval page. */
export interface DeviceRequestDto {
  userCode: string;
  clientName: string;
  status: "pending" | "approved" | "denied" | "consumed";
  expiresAt: string;
}

/** POST /device/token once approved: an agent API key for the device. */
export interface DeviceTokenResponse {
  access_token: string;
  token_type: "Bearer";
  actor: ActorDto;
  organization: OrganizationDto;
}

export interface CommentDto {
  id: string;
  taskKey: string;
  parentId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

/** A comment on a document (ST-118): on the whole document, or on a fragment of it (`quote`). */
export interface DocumentCommentDto {
  id: string;
  documentId: string;
  /** The comment this one replies to; replies sit in their top-level comment's thread. */
  parentId: string | null;
  authorId: string;
  body: string;
  /** The text the comment is about (top-level comments only); null when it is about the whole document. */
  quote: string | null;
  /** The quote no longer occurs in the document's current content (the fragment changed). */
  outdated: boolean;
  /** The document's version when the comment was posted. */
  documentVersion: number;
  /** Set when the thread (a top-level comment) was marked resolved. */
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  editedAt: string | null;
}

/**
 * `rules`: the rules of one of your projects were set or changed (ST-111). `document_mention`,
 * `document_reply`, `document_comment`: a comment on a document mentions you, replies to you, or
 * is on a document you wrote or a thread you're in (ST-118). These have a document, not a task.
 */
export type InboxKind =
  | "mention"
  | "assigned"
  | "comment"
  | "reply"
  | "rules"
  | "document_mention"
  | "document_comment"
  | "document_reply";
/** The kinds about a task. */
export type TaskInboxKind = "mention" | "assigned" | "comment" | "reply";
/** The kinds about a comment on a document. */
export type DocumentInboxKind = "document_mention" | "document_comment" | "document_reply";

export interface InboxItemDto {
  /** Increasing; pass the last one seen as `after` to get only newer items. */
  id: number;
  kind: InboxKind;
  createdAt: string;
  readAt: string | null;
  /** Null for `rules` and `document_*` items. */
  task: { key: string; title: string } | null;
  /** Set for `rules` items (the project's rules document) and `document_*` items (the commented document; projectKey is null for an organization-wide one). */
  document: { id: string; title: string; projectKey: string | null } | null;
  comment: { id: string; body: string } | null;
  from: { id: string; handle: string; name: string; type: ActorType };
}

/** One entry of a task's history, from the activity log. */
export interface ActivityDto {
  id: number;
  /** e.g. "task.created", "task.updated", "comment.created" */
  action: string;
  /** For task.updated: field → [before, after] (statusId, assigneeIds, title, priority, …). */
  changes: Record<string, unknown> | null;
  /** ui | api | mcp | cli | git | agent_run | system (the tracker itself, ST-96) */
  source: string;
  actorId: string;
  createdAt: string;
}

/** How a related task relates to this one, from this task's point of view. */
export type RelationKind = "blocks" | "blocked_by" | "relates" | "duplicates" | "duplicated_by";

export interface RelationDto {
  kind: RelationKind;
  task: { id: string; key: string; title: string; statusId: string };
}

export type DocumentFormat = "md" | "html";

/** A document without its content, as listed. */
export interface DocumentSummaryDto {
  id: string;
  title: string;
  format: DocumentFormat;
  /** Null for organization-wide documents. */
  projectKey: string | null;
  /** Set for task documents, e.g. "ST-12". */
  taskKey: string | null;
  /** Increases with every save. */
  version: number;
  /** Who saved the current version. */
  authorId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The web page's address (ST-115); set in API, CLI and MCP responses, not by core itself. */
  url?: string;
}

export interface DocumentDto extends DocumentSummaryDto {
  content: string;
}

/**
 * What a rename did to the `[[Old title]]` links leading to the document (ST-101): the documents
 * rewritten (one new version each, by the renamer) and those left as they were. `rules`: a project's
 * rules document, which only owners, admins and their agents may save; `too_large`: the rewrite would
 * take it over 1 MB. Documents the renamer can't see are neither rewritten nor listed.
 */
export interface RelinkedDocumentsDto {
  rewritten: { id: string; title: string }[];
  skipped: { id: string; title: string; reason: "rules" | "too_large" }[];
}

/** A saved document; `relinked` is set when the save renamed it. */
export interface UpdatedDocumentDto extends DocumentDto {
  relinked?: RelinkedDocumentsDto;
}

/** Where a document link leads: a document, a task, or a title no document has (yet). */
export type DocumentLinkTarget =
  | { type: "document"; id: string }
  | { type: "task"; key: string }
  /** The title as written; no visible document has it. */
  | { type: "unresolved"; title: string };

/** A link from a document's content: `[[…]]` (wiki) or a plain task key (mention). */
export interface DocumentLinkDto {
  from: string;
  to: DocumentLinkTarget;
}

export interface DocumentGraphTaskDto {
  key: string;
  title: string;
  projectKey: string;
  statusCategory: StatusCategory;
  /** The task's web page (ST-115); set in API responses. */
  url?: string;
}

/**
 * Every document the viewer can see, the tasks and projects they belong to or link to, and the
 * links between them. Containment (a task's document, a project's task) follows from the keys.
 */
export interface DocumentGraphDto {
  documents: DocumentSummaryDto[];
  tasks: DocumentGraphTaskDto[];
  projects: { key: string; name: string; /** The web page's address (ST-107); set by the API and MCP. */ url?: string }[];
  links: DocumentLinkDto[];
}

export interface DocumentVersionSummaryDto {
  version: number;
  title: string;
  format: DocumentFormat;
  authorId: string | null;
  createdAt: string;
}

export interface DocumentVersionDto extends DocumentVersionSummaryDto {
  documentId: string;
  content: string;
}

/** One line of a line diff: unchanged context, added (only in the new text) or removed (only in the old). */
export interface DiffLineDto {
  kind: "context" | "added" | "removed";
  text: string;
  /** 1-based line number in the old text; null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the new text; null for removed lines. */
  newLine: number | null;
}

/** A run of changes with up to 3 lines of context around them, as in a unified diff's `@@` block. */
export interface DiffHunkDto {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLineDto[];
}

/** What changed between two saved versions of a document (ST-117), line by line. */
export interface DocumentDiffDto {
  documentId: string;
  from: DocumentVersionSummaryDto;
  to: DocumentVersionSummaryDto;
  /** Lines added and removed. */
  added: number;
  removed: number;
  /** Empty when the contents match (the title or format may still differ). */
  hunks: DiffHunkDto[];
}

export type InvitationStatus = "active" | "expired" | "revoked" | "used_up";

export interface InvitationDto {
  id: string;
  /** Formatted for display, e.g. "ABCD-EFGH"; accepted with or without the dash, in any case. */
  code: string;
  role: Exclude<ActorRole, "owner">;
  status: InvitationStatus;
  useCount: number;
  maxUses: number | null;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** What a code would join, shown before accepting. */
export interface InvitationPreviewDto {
  organization: OrganizationDto;
  role: Exclude<ActorRole, "owner">;
  alreadyMember: boolean;
}
