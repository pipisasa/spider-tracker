import {
  acceptAgentInviteInput,
  bulkUpdateTasksInput,
  createAgentInviteInput,
  createAgentInput,
  createApiKeyInput,
  createCommentInput,
  createDocumentCommentInput,
  resolveDocumentCommentInput,
  createTagInput,
  attachRepoInput,
  openPullRequestInput,
  createAppInput,
  createRepoInput,
  updateAppInput,
  updateRepoInput,
  createSavedViewInput,
  updateSavedViewInput,
  viewFiltersSchema,
  createOrganizationInput,
  deviceCodeInput,
  relationInput,
  relationKindSchema,
  createProjectInput,
  createStatusInput,
  updateStatusInput,
  createTaskInput,
  createDocumentInput,
  createInvitationInput,
  invitationCodeInput,
  markInboxReadInput,
  markDuplicateInput,
  updateAgentInput,
  updateDocumentInput,
  editDocumentInput,
  moveDocumentInput,
  updateProjectInput,
  updateTaskInput,
  createReleaseInput,
  createMilestoneInput,
  updateReleaseInput,
  releaseTasksInput,
  releaseChangelogInput,
  recordDeploymentInput,
} from "@repo/core/schemas";
import { z } from "zod";

// OpenAPI 3.1 description of the public API, served at GET /openapi.json.
// Request bodies come from the same Zod schemas core validates with; response
// shapes mirror @repo/core/contracts.

type JsonSchema = Record<string, unknown>;

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, extra: JsonSchema = {}): JsonSchema => ({ type: [type, "null"], ...extra });
const string = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});
/** The `url` field: the web page of a project, task or document (ST-115). */
const webUrl = (what: string): JsonSchema =>
  string({ format: "uri", description: `The ${what}'s page in the web app, from the server's web origin` });
const automationTarget = (description: string): JsonSchema => ({
  type: ["string", "null"],
  enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled", null],
  description,
});
const listOf = (item: string): JsonSchema => object({ items: { type: "array", items: ref(item) } });

/** Request-side JSON Schema of a Zod schema, without the $schema header. */
function fromZod(schema: z.ZodType): JsonSchema {
  const jsonSchema: JsonSchema = z.toJSONSchema(schema, { io: "input" });
  delete jsonSchema.$schema;
  return jsonSchema;
}

const schemas: Record<string, JsonSchema> = {
  Error: object({
    error: {
      type: "object",
      properties: {
        code: string(),
        message: string(),
        url: string({
          format: "uri",
          description: "What the error is about, when it has an address: the pull request already open (409 from POST /tasks/{taskKey}/pull-request)",
        }),
      },
      required: ["code", "message"],
    },
  }),
  Organization: object({ id: string({ format: "uuid" }), slug: string(), name: string() }),
  Actor: object({
    id: string({ format: "uuid" }),
    type: string({
      enum: ["human", "agent", "integration"],
      description: "integration: a per-organization bot such as GitHub (listed only with ?all=true)",
    }),
    name: string(),
    handle: string(),
    avatarUrl: nullable("string"),
    role: string({ enum: ["owner", "admin", "member", "guest"] }),
    deactivated: { type: "boolean" },
    ownerId: nullable("string", { format: "uuid", description: "For agents, the owning person's actor id; null for people" }),
  }),
  Membership: object({ organization: ref("Organization"), actor: ref("Actor") }),
  Me: object({
    user: object({ id: string(), name: string(), email: string(), image: nullable("string") }),
    memberships: { type: "array", items: ref("Membership") },
  }),
  Status: object({
    id: string({ format: "uuid" }),
    kind: ref("TaskKind"),
    name: string(),
    category: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
    color: nullable("string"),
    position: { type: "integer", description: "Board order within its kind's workflow, from 0" },
  }),
  TaskKind: string({
    enum: ["task", "release", "milestone"],
    description: "What a task is; each kind has its own workflow of statuses in every project",
  }),
  Project: object({
    id: string({ format: "uuid" }),
    key: string(),
    name: string(),
    description: nullable("string"),
    createdAt: string({ format: "date-time" }),
    archivedAt: nullable("string", {
      format: "date-time",
      description: "Archived projects are left out of lists and refuse new tasks",
    }),
    rulesDocumentId: nullable("string", {
      format: "uuid",
      description: "The project's rules for agents: one of its project-level documents (set with PATCH rulesDocumentId)",
    }),
    gitAutomation: ref("GitAutomation"),
    url: webUrl("project"),
  }),
  GitAutomation: {
    ...object({
      enabled: { type: "boolean" },
      draft: automationTarget("A PR opened as or converted to a draft (default in_progress)"),
      opened: automationTarget("A PR opened, reopened or marked ready for review (default in_review)"),
      merged: automationTarget("A PR merged (default done)"),
      closed: automationTarget("A PR closed without merging (default null: no change)"),
    }),
    description:
      "Status automation from pull request events (set with PATCH gitAutomation; null resets to the defaults). Each event names the status category " +
      "its linked tasks move to: the first status of that category in the task's workflow. Only tasks of kind task move, only for PRs linked by " +
      "closing keyword, branch or title, and only forward (a draft may move In Review back to In Progress); merged waits for the task's other open PRs.",
  },
  ProjectDetail: {
    allOf: [
      ref("Project"),
      object({
        statuses: { type: "array", items: ref("Status"), description: "The workflow of kind task, in board order" },
        workflows: {
          ...object({
            task: { type: "array", items: ref("Status") },
            release: { type: "array", items: ref("Status") },
            milestone: { type: "array", items: ref("Status") },
          }),
          description: "Every kind's workflow, in board order",
        },
      }),
    ],
  },
  DeletedStatus: object({
    project: ref("ProjectDetail"),
    movedTasks: { type: "integer", description: "Tasks moved to the target status (deleted ones too)" },
  }),
  Task: object({
    id: string({ format: "uuid" }),
    key: string({ examples: ["SPI-12"] }),
    number: { type: "integer" },
    projectId: string({ format: "uuid" }),
    kind: ref("TaskKind"),
    title: string(),
    description: nullable("string"),
    statusId: string({ format: "uuid", description: "A status of the workflow of the task's project and kind" }),
    priority: { type: "integer", enum: [0, 1, 2, 3, 4], description: "0 none, 1 urgent, 2 high, 3 medium, 4 low" },
    parentId: nullable("string", { format: "uuid" }),
    parentKey: nullable("string", { examples: ["SPI-3"] }),
    sortKey: string(),
    startDate: nullable("string", { format: "date", description: "Plan start, YYYY-MM-DD", examples: ["2026-10-01"] }),
    targetDate: nullable("string", {
      format: "date",
      description: "Plan target, YYYY-MM-DD, on or after startDate; past it (UTC) and not done or canceled = overdue",
      examples: ["2026-10-31"],
    }),
    assigneeIds: { type: "array", items: string({ format: "uuid" }) },
    tagIds: { type: "array", items: string({ format: "uuid" }) },
    creatorId: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
    completedAt: nullable("string", { format: "date-time" }),
    subtasks: nullable("object", {
      description: "Direct sub-tasks the caller can see; closed = done or canceled. Null when there are none",
      properties: { done: { type: "integer" }, total: { type: "integer" } },
      required: ["done", "total"],
      additionalProperties: false,
    }),
    releaseId: nullable("string", {
      format: "uuid",
      description: "The release (a task of kind release) this task ships in; null when in none or in one the caller can't see",
    }),
    shippedAt: nullable("string", { format: "date-time", description: "When its release was marked Released (for a release: when it was)" }),
    noCode: { type: "boolean", description: "Marked as having no code to ship: it never needs a release" },
    shipping: {
      description: "Where a Done task's code is (Done means finished, not shipped); null for releases, milestones and tasks that aren't Done and in no release",
      oneOf: [{ type: "null" }, ref("TaskShipping")],
    },
    milestoneId: nullable("string", {
      format: "uuid",
      description: "The milestone (a task of kind milestone, same project) the task was put in itself; null when none (it may still inherit its parent's)",
    }),
    milestone: {
      description: "The milestone the task belongs to: its own, else the nearest ancestor's (inherited); null when in none or in one the caller can't see",
      oneOf: [{ type: "null" }, ref("MilestoneRef")],
    },
    url: webUrl("task"),
  }),
  MilestoneRef: object({
    id: string({ format: "uuid" }),
    key: string(),
    title: string({ examples: ["Phase 4: Git and GitHub"] }),
    status: ref("StatusRef"),
    inherited: { type: "boolean", description: "Taken from an ancestor; the task has no milestone of its own" },
  }),
  StatusRef: object({
    id: string({ format: "uuid" }),
    name: string(),
    category: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
  }),
  TaskShipping: object({
    state: string({ enum: ["not_in_release", "in_release", "shipped", "no_code"] }),
    release: {
      description: "The release it is in; null when in none, or in one the caller can't see",
      oneOf: [
        { type: "null" },
        object({ id: string({ format: "uuid" }), key: string(), title: string({ examples: ["2026.10.13"] }), status: ref("StatusRef") }),
      ],
    },
  }),
  Release: {
    allOf: [
      ref("Task"),
      object({
        status: ref("StatusRef"),
        repos: { type: "array", items: object({ id: string({ format: "uuid" }), fullName: string({ examples: ["pipisasa/spider-tracker"] }) }) },
        apps: {
          type: "array",
          items: object({
            appId: string({ format: "uuid" }),
            repo: string(),
            name: string({ examples: ["web"] }),
            versioning: string({ enum: ["date", "semver"] }),
            environments: { type: "array", items: string() },
            version: string({ examples: ["2026.10.13", "0.1.8"] }),
          }),
        },
        tasks: {
          type: "array",
          description: "The included Done tasks (a project-scoped agent: only its projects'), by project key and number",
          items: object({
            id: string({ format: "uuid" }),
            key: string(),
            title: string(),
            projectKey: string(),
            status: ref("StatusRef"),
            completedAt: nullable("string", { format: "date-time" }),
            shippedAt: nullable("string", { format: "date-time" }),
            url: webUrl("task"),
          }),
        },
        deployments: { type: "array", description: "Its deployments, newest first (ST-94)", items: ref("Deployment") },
      }),
    ],
  },
  ReleaseList: listOf("Release"),
  Deployment: object({
    id: string({ format: "uuid" }),
    releaseId: string({ format: "uuid" }),
    releaseKey: string({ examples: ["ST-120"] }),
    appId: string({ format: "uuid" }),
    app: string({ examples: ["web"] }),
    repo: string({ examples: ["pipisasa/spider-tracker"] }),
    environment: string({ examples: ["staging", "prod"] }),
    production: { type: "boolean", description: "The environment is the app's last one, its production" },
    commitSha: string({ examples: ["3f2c1ab9d0e4"] }),
    deployedBy: {
      description: "Who recorded it; null once that actor is gone",
      oneOf: [{ type: "null" }, object({ id: string({ format: "uuid" }), handle: string(), name: string() })],
    },
    source: string({ examples: ["cli", "mcp", "api", "ui"] }),
    createdAt: string({ format: "date-time" }),
  }),
  DeploymentList: listOf("Deployment"),
  RecordDeploymentInput: fromZod(recordDeploymentInput),
  RecordedDeployment: object({
    deployment: ref("Deployment"),
    release: ref("Release"),
    movedFrom: {
      description: "The status the release left when this deployment moved it (Planned → On staging); null when it stayed",
      oneOf: [{ type: "null" }, ref("StatusRef")],
    },
  }),
  Milestone: {
    allOf: [
      ref("Task"),
      object({
        status: ref("StatusRef"),
        progress: object({
          total: { type: "integer", description: "Its tasks (own and inherited by sub-tasks) that aren't canceled" },
          done: { type: "integer", description: "Of those, in a done status" },
          canceled: { type: "integer", description: "Canceled tasks, not part of total" },
          withCode: { type: "integer", description: "Of the done ones, those with code to ship (not noCode)" },
          shipped: { type: "integer", description: "Of the done ones with code, those whose release is Released" },
          complete: { type: "boolean", description: "Every task done and all their code shipped (and at least one task)" },
        }),
        tasks: {
          type: "array",
          description: "Its tasks the caller can see, by project key and number",
          items: object({
            id: string({ format: "uuid" }),
            key: string(),
            title: string(),
            projectKey: string(),
            status: ref("StatusRef"),
            parentKey: nullable("string"),
            inherited: { type: "boolean", description: "In the milestone through an ancestor" },
            completedAt: nullable("string", { format: "date-time" }),
            shipping: { oneOf: [{ type: "null" }, ref("TaskShipping")] },
            url: webUrl("task"),
          }),
        },
        releases: {
          type: "array",
          description: "Releases that include its tasks: Released ones first (oldest first), then those on their way",
          items: object({
            id: string({ format: "uuid" }),
            key: string(),
            title: string({ examples: ["2026.10.13"] }),
            status: ref("StatusRef"),
            shippedAt: nullable("string", { format: "date-time" }),
            tasks: { type: "array", items: string(), description: "Keys of the milestone's tasks it includes" },
          }),
        },
      }),
    ],
  },
  MilestoneList: listOf("Milestone"),
  CreateMilestoneInput: fromZod(createMilestoneInput),
  CreateReleaseInput: fromZod(createReleaseInput),
  UpdateReleaseInput: fromZod(updateReleaseInput),
  ReleaseTasksInput: fromZod(releaseTasksInput),
  ReleaseChangelog: object({
    release: object({ id: string({ format: "uuid" }), key: string(), title: string(), url: webUrl("task") }),
    apps: {
      type: "array",
      items: object({
        name: string({ examples: ["web"] }),
        repo: string(),
        version: string({ examples: ["2026.10.13"] }),
        tag: string({ examples: ["web-2026.10.13", "cli-v0.1.8"] }),
      }),
    },
    grouped: { type: "boolean", description: "Entries carry the apps they touch, so markdown has a section per app" },
    entries: {
      type: "array",
      description: "The included tasks (a project-scoped agent: only its projects'), by project key and number",
      items: object({
        key: string(),
        title: string(),
        projectKey: string(),
        whatChanged: nullable("string", {
          description: 'The "What changed" section of the handoff note: the latest comment with one by an assignee, else by anyone',
        }),
        handoff: {
          oneOf: [object({ commentId: string({ format: "uuid" }), authorId: string({ format: "uuid" }), createdAt: string({ format: "date-time" }) }), { type: "null" }],
        },
        apps: { type: "array", items: string(), description: "The release's apps the task touches; empty when unknown" },
        url: webUrl("task"),
      }),
    },
    markdown: string({ description: "The generated changelog: a ### section per app when grouped" }),
    description: object({
      state: string({
        enum: ["missing", "current", "outdated", "edited"],
        description: "The description's changelog block: none, the same as markdown, generated earlier, or edited by hand",
      }),
      content: nullable("string"),
    }),
    written: nullable("string", { enum: ["added", "replaced", "unchanged", null], description: "What a write did; null for a read" }),
  }),
  ReleaseChangelogInput: fromZod(releaseChangelogInput),
  Presence: object({
    taskKey: string(),
    actorId: string({ format: "uuid" }),
    lastSeenAt: string({ format: "date-time", description: "Latest action or read by the agent on the task" }),
  }),
  Subtask: {
    allOf: [
      ref("Task"),
      object({
        status: object({
          id: string({ format: "uuid" }),
          name: string(),
          category: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
          color: nullable("string"),
        }),
      }),
    ],
  },
  Comment: object({
    id: string({ format: "uuid" }),
    taskKey: string(),
    parentId: nullable("string", { format: "uuid" }),
    authorId: string({ format: "uuid" }),
    body: string({ description: "Markdown; @handle mentions notify members" }),
    createdAt: string({ format: "date-time" }),
    editedAt: nullable("string", { format: "date-time" }),
  }),
  DocumentComment: object({
    id: string({ format: "uuid" }),
    documentId: string({ format: "uuid" }),
    parentId: nullable("string", { format: "uuid", description: "The comment replied to" }),
    authorId: string({ format: "uuid" }),
    body: string({ description: "Markdown; @handle mentions notify members" }),
    quote: nullable("string", { description: "The fragment the comment is about (top-level comments); null: the whole document" }),
    outdated: { type: "boolean", description: "The quote no longer occurs in the current content" },
    documentVersion: { type: "integer", description: "The document's version when the comment was posted" },
    resolvedAt: nullable("string", { format: "date-time", description: "Set when the thread was marked resolved" }),
    resolvedBy: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    editedAt: nullable("string", { format: "date-time" }),
  }),
  DocumentCommentList: listOf("DocumentComment"),
  CreateDocumentCommentInput: fromZod(createDocumentCommentInput),
  ResolveDocumentCommentInput: fromZod(resolveDocumentCommentInput),
  InboxItem: object({
    id: { type: "integer", description: "Increasing; use as the `after` cursor" },
    kind: string({
      enum: ["mention", "assigned", "comment", "reply", "rules", "document_mention", "document_comment", "document_reply"],
      description:
        "rules: a project's rules were set or changed; document_*: a comment on a document mentions you, replies to you, or is on your document or thread. Both are returned only when asked for with `kinds`",
    }),
    createdAt: string({ format: "date-time" }),
    readAt: nullable("string", { format: "date-time" }),
    task: { oneOf: [object({ key: string(), title: string() }), { type: "null" }], description: "Null for rules and document_* items" },
    document: {
      oneOf: [object({ id: string({ format: "uuid" }), title: string(), projectKey: nullable("string") }), { type: "null" }],
      description: "For rules items the project's rules document; for document_* items the commented document (projectKey null when organization-wide)",
    },
    comment: { oneOf: [object({ id: string({ format: "uuid" }), body: string() }), { type: "null" }] },
    from: object({ id: string({ format: "uuid" }), handle: string(), name: string(), type: string({ enum: ["human", "agent"] }) }),
  }),
  Tag: object({ id: string({ format: "uuid" }), name: string(), color: nullable("string") }),
  TagList: listOf("Tag"),
  CreateTagInput: fromZod(createTagInput),
  App: object({
    id: string({ format: "uuid" }),
    repoId: string({ format: "uuid" }),
    repo: string({ examples: ["pipisasa/spider-tracker"], description: "The repo's owner/name" }),
    name: string({ examples: ["web"] }),
    path: string({ examples: ["web/app"], description: 'Its folder in the repo ("." for the whole repo)' }),
    sharedPaths: { type: "array", items: string(), description: 'Shared packages it depends on, e.g. "packages/core"' },
    versioning: string({ enum: ["date", "semver"] }),
    environments: { type: "array", items: string(), description: 'Deploy order, e.g. ["staging", "prod"]; empty for a CLI' },
    createdAt: string({ format: "date-time" }),
  }),
  Repo: object({
    id: string({ format: "uuid" }),
    owner: string(),
    name: string(),
    fullName: string({ examples: ["pipisasa/spider-tracker"] }),
    defaultBranch: string(),
    githubInstallationId: nullable("integer", { description: "Set once the GitHub App is installed on the repo; null for repos added by URL" }),
    projects: { type: "array", items: string(), description: "Keys of the projects it is attached to (those the caller can see)" },
    apps: { type: "array", items: ref("App") },
    createdAt: string({ format: "date-time" }),
  }),
  RepoList: listOf("Repo"),
  GithubInstallation: object({
    id: { type: "integer", description: "GitHub's installation id" },
    account: string({ description: "The GitHub user or organization the App is installed on" }),
    accountType: string({ enum: ["User", "Organization"] }),
    repositorySelection: string({ enum: ["all", "selected"] }),
    suspended: { type: "boolean" },
    repos: { type: "array", items: string(), description: '"owner/name" of the repos it grants (a project-scoped agent: its projects\' only)' },
    settingsUrl: string({ format: "uri", description: "Where the installation is configured or uninstalled on GitHub" }),
    connectedBy: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
  }),
  GithubStatus: object({
    configured: { type: "boolean", description: "False when the server has no GITHUB_APP_* settings: install and sync answer 503" },
    appSlug: nullable("string"),
    installations: { type: "array", items: ref("GithubInstallation") },
  }),
  GithubInstallUrl: object({ url: string({ format: "uri" }) }),
  PullRequest: object({
    repo: string({ examples: ["pipisasa/spider-tracker"] }),
    number: { type: "integer" },
    title: string(),
    url: string({ format: "uri" }),
    state: string({ enum: ["open", "closed", "merged"], description: '"merged" is final; "closed" is closed without merging' }),
    draft: { type: "boolean" },
    headBranch: string(),
    baseBranch: string(),
    author: nullable("string", { description: "GitHub login of who opened it" }),
    mergedAt: nullable("string", { format: "date-time" }),
    closedAt: nullable("string", { format: "date-time" }),
    updatedAt: string({ format: "date-time", description: "Its last change on GitHub" }),
    via: ref("GitLinkVia"),
  }),
  GitLinkVia: string({
    enum: ["closing", "branch", "title", "body", "message"],
    description: 'How the task key was found, strongest first: a closing keyword ("fixes ST-12"), the branch name, the PR title, the PR body, a commit message',
  }),
  GitBranch: object({
    repo: string(),
    name: string(),
    url: string({ format: "uri" }),
    deleted: { type: "boolean", description: "Deleted on GitHub since" },
    linkedAt: string({ format: "date-time" }),
  }),
  GitCommit: object({
    repo: string(),
    sha: string(),
    message: string({ description: "The first line" }),
    url: string({ format: "uri" }),
    author: nullable("string", { description: "GitHub login, or the git author name" }),
    committedAt: nullable("string", { format: "date-time" }),
    via: ref("GitLinkVia"),
  }),
  TaskGit: object({
    taskKey: string(),
    pullRequests: { type: "array", items: ref("PullRequest"), description: "Recently updated first" },
    branches: { type: "array", items: ref("GitBranch"), description: "Newest first" },
    commits: { type: "array", items: ref("GitCommit"), description: "The latest 100, newest first" },
  }),
  OpenPullRequestInput: fromZod(openPullRequestInput),
  OpenedPullRequest: object({
    taskKey: string(),
    pullRequest: ref("PullRequest"),
  }),
  CreateRepoInput: fromZod(createRepoInput),
  UpdateRepoInput: fromZod(updateRepoInput),
  AttachRepoInput: fromZod(attachRepoInput),
  CreateAppInput: fromZod(createAppInput),
  UpdateAppInput: fromZod(updateAppInput),
  ViewFilters: fromZod(viewFiltersSchema),
  SavedView: object({
    id: string({ format: "uuid" }),
    projectKey: string(),
    ownerActorId: string({ format: "uuid" }),
    name: string(),
    filters: ref("ViewFilters"),
    shared: { type: "boolean" },
    view: string({ enum: ["board", "list"] }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
  }),
  SavedViewList: listOf("SavedView"),
  CreateSavedViewInput: fromZod(createSavedViewInput),
  UpdateSavedViewInput: fromZod(updateSavedViewInput),
  Relation: object({
    kind: string({ enum: ["blocks", "blocked_by", "relates", "duplicates", "duplicated_by"] }),
    task: object({ id: string({ format: "uuid" }), key: string(), title: string(), statusId: string({ format: "uuid" }) }),
  }),
  RelationList: listOf("Relation"),
  RelationInput: fromZod(relationInput),
  MarkDuplicateInput: fromZod(markDuplicateInput),
  CommentList: listOf("Comment"),
  InboxList: listOf("InboxItem"),
  MarkedCount: object({ updated: { type: "integer" } }),
  CreateCommentInput: fromZod(createCommentInput),
  MarkInboxReadInput: fromZod(markInboxReadInput),
  DocumentSummary: object({
    id: string({ format: "uuid" }),
    title: string(),
    format: string({ enum: ["md", "html"] }),
    projectKey: nullable("string", { description: "Null for organization-wide documents" }),
    taskKey: nullable("string", { description: "Set for task documents" }),
    version: { type: "integer", description: "Increases with every save; send it back as baseVersion" },
    authorId: string({ format: "uuid", description: "Who saved the current version" }),
    createdBy: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
    updatedAt: string({ format: "date-time" }),
    url: webUrl("document"),
  }),
  Document: { allOf: [ref("DocumentSummary"), object({ content: string() })] },
  UpdatedDocument: {
    allOf: [
      ref("Document"),
      {
        type: "object",
        properties: {
          relinked: {
            ...object({
              rewritten: { type: "array", items: object({ id: string({ format: "uuid" }), title: string() }) },
              skipped: {
                type: "array",
                items: object({
                  id: string({ format: "uuid" }),
                  title: string(),
                  reason: string({
                    enum: ["rules", "too_large"],
                    description: "rules: a project's rules document you may not change; too_large: the rewrite would pass 1 MB",
                  }),
                }),
              },
            }),
            description:
              "Set when the save renamed the document: the documents whose [[Old title]] links were rewritten (a new version each, by you) and those skipped. Documents you can't see are left as they are",
          },
        },
      },
    ],
  },
  DocumentList: listOf("DocumentSummary"),
  DocumentVersionSummary: object({
    version: { type: "integer" },
    title: string(),
    format: string({ enum: ["md", "html"] }),
    authorId: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  DocumentVersion: {
    allOf: [ref("DocumentVersionSummary"), object({ documentId: string({ format: "uuid" }), content: string() })],
  },
  DocumentVersionList: listOf("DocumentVersionSummary"),
  DiffLine: object({
    kind: string({ enum: ["context", "added", "removed"] }),
    text: string(),
    oldLine: nullable("integer", { description: "1-based line in the older version; null for added lines" }),
    newLine: nullable("integer", { description: "1-based line in the newer version; null for removed lines" }),
  }),
  DiffHunk: object({
    oldStart: { type: "integer" },
    oldLines: { type: "integer" },
    newStart: { type: "integer" },
    newLines: { type: "integer" },
    lines: { type: "array", items: ref("DiffLine") },
  }),
  DocumentDiff: object({
    documentId: string({ format: "uuid" }),
    from: ref("DocumentVersionSummary"),
    to: ref("DocumentVersionSummary"),
    added: { type: "integer", description: "Lines added" },
    removed: { type: "integer", description: "Lines removed" },
    hunks: {
      type: "array",
      items: ref("DiffHunk"),
      description: "Changes with 3 lines of context, as in a unified diff; empty when the contents match",
    },
  }),
  DocumentLink: object({
    from: string({ format: "uuid", description: "The linking document" }),
    to: {
      oneOf: [
        object({ type: string({ const: "document" }), id: string({ format: "uuid" }) }),
        object({ type: string({ const: "task" }), key: string() }),
        object({ type: string({ const: "unresolved" }), title: string({ description: "As first written; titles match case-insensitively" }) }),
      ],
    },
  }),
  DocumentGraph: object({
    documents: { type: "array", items: ref("DocumentSummary") },
    tasks: {
      type: "array",
      items: object({
        key: string(),
        title: string(),
        projectKey: string(),
        statusCategory: string({ enum: ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] }),
        url: webUrl("task"),
      }),
    },
    projects: { type: "array", items: object({ key: string(), name: string(), url: webUrl("project") }) },
    links: { type: "array", items: ref("DocumentLink") },
  }),
  CreateDocumentInput: fromZod(createDocumentInput),
  UpdateDocumentInput: fromZod(updateDocumentInput),
  EditDocumentInput: fromZod(editDocumentInput),
  MoveDocumentInput: fromZod(moveDocumentInput),
  Invitation: object({
    id: string({ format: "uuid" }),
    code: string({ examples: ["ABCD-EFGH"], description: "Accepted with or without the dash, in any case" }),
    role: string({ enum: ["admin", "member", "guest"] }),
    status: string({ enum: ["active", "expired", "revoked", "used_up"] }),
    useCount: { type: "integer" },
    maxUses: nullable("integer"),
    expiresAt: string({ format: "date-time" }),
    revokedAt: nullable("string", { format: "date-time" }),
    createdBy: nullable("string", { format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  InvitationList: listOf("Invitation"),
  InvitationPreview: object({
    organization: ref("Organization"),
    role: string({ enum: ["admin", "member", "guest"] }),
    alreadyMember: { type: "boolean" },
  }),
  CreateInvitationInput: fromZod(createInvitationInput),
  InvitationCodeInput: fromZod(invitationCodeInput),
  ApiKey: object({
    id: string({ format: "uuid" }),
    name: string(),
    prefix: string({ examples: ["spt_a1b2c3"], description: "First characters of the key, to recognise it" }),
    createdAt: string({ format: "date-time" }),
    lastUsedAt: nullable("string", { format: "date-time" }),
    revokedAt: nullable("string", { format: "date-time" }),
  }),
  CreatedApiKey: object({ key: ref("ApiKey"), secret: string({ description: "Shown only once" }) }),
  Agent: object({
    actor: ref("Actor"),
    ownerId: string({ format: "uuid" }),
    owner: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
    description: nullable("string"),
    canManage: { type: "boolean", description: "The caller owns the agent or is an organization owner/admin" },
    keys: { type: "array", items: ref("ApiKey"), description: "Empty unless canManage" },
    projects: {
      type: ["array", "null"],
      items: ref("ProjectRef"),
      description: "Projects the agent is limited to (empty once they are all deleted); null when it sees every project",
    },
  }),
  AgentList: listOf("Agent"),
  ProjectRef: object({ key: string(), name: string() }),
  AgentInvite: object({
    id: string({ format: "uuid" }),
    code: string({ examples: ["ABCD-EFGH"] }),
    status: string({ enum: ["pending", "expired"] }),
    expiresAt: string({ format: "date-time" }),
    createdAt: string({ format: "date-time" }),
    createdBy: nullable("string", { format: "uuid" }),
    agent: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
    projects: { type: "array", items: ref("ProjectRef") },
  }),
  AgentInviteList: listOf("AgentInvite"),
  CreatedAgentInvite: object({
    invite: ref("AgentInvite"),
    agent: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
  }),
  AcceptedAgentInvite: object({
    token: string({ description: "The agent's API key (spt_…); shown only once" }),
    actor: ref("Actor"),
    organization: ref("Organization"),
    projects: { type: "array", items: ref("ProjectRef") },
    owner: object({ id: string({ format: "uuid" }), name: string(), handle: string() }),
  }),
  CreateAgentInviteInput: fromZod(createAgentInviteInput),
  AcceptAgentInviteInput: fromZod(acceptAgentInviteInput),
  CreateAgentInput: fromZod(createAgentInput),
  UpdateAgentInput: fromZod(updateAgentInput),
  CreateApiKeyInput: fromZod(createApiKeyInput),
  ActorList: listOf("Actor"),
  ProjectList: listOf("Project"),
  TaskList: listOf("Task"),
  SubtaskList: listOf("Subtask"),
  PresenceList: listOf("Presence"),
  CreateProjectInput: fromZod(createProjectInput),
  UpdateProjectInput: fromZod(updateProjectInput),
  CreateStatusInput: fromZod(createStatusInput),
  UpdateStatusInput: fromZod(updateStatusInput),
  CreateTaskInput: fromZod(createTaskInput),
  UpdateTaskInput: fromZod(updateTaskInput),
  BulkUpdateTasksInput: fromZod(bulkUpdateTasksInput),
  BulkTaskResult: object({
    key: string({ description: "The task's key; for an error, the key as given" }),
    outcome: string({ enum: ["changed", "unchanged", "error"], description: 'In a dry run, "changed" means it would change' }),
    task: { oneOf: [ref("Task"), { type: "null" }], description: "The task after the change (as it would be, in a dry run); null on error" },
    error: nullable("object", {
      description: 'Why this task wasn\'t changed, e.g. { code: "not_found" } for a missing or out-of-scope task',
      properties: { code: string(), message: string() },
      required: ["code", "message"],
    }),
  }),
  BulkUpdateTasksResult: object({
    dryRun: { type: "boolean" },
    summary: object({ changed: { type: "integer" }, unchanged: { type: "integer" }, failed: { type: "integer" } }),
    results: { type: "array", items: ref("BulkTaskResult"), description: "In the order of the keys given, or board order for a filter" },
  }),
  CreateOrganizationInput: fromZod(createOrganizationInput),
  AuthProviders: object({ providers: { type: "array", items: string({ enum: ["magic-link", "github", "batele-id"] }) } }),
  Activity: object({
    id: { type: "integer", description: "Increasing; entries come oldest first" },
    action: string({ examples: ["task.created", "task.updated", "comment.created"] }),
    changes: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "For task.updated: field → [before, after] (statusId, assigneeIds, tagIds, parentId, title, priority, …)",
    },
    source: string({ enum: ["ui", "api", "mcp", "cli", "git", "agent_run", "system"] }),
    actorId: string({ format: "uuid" }),
    createdAt: string({ format: "date-time" }),
  }),
  ActivityList: listOf("Activity"),
  DeviceCodeInput: fromZod(deviceCodeInput),
  DeviceTokenInput: {
    type: "object",
    properties: { grant_type: string({ const: "urn:ietf:params:oauth:grant-type:device_code" }), device_code: string() },
    required: ["device_code"],
  },
  DeviceCode: object({
    device_code: string(),
    user_code: string({ examples: ["WDJB-MJHT"] }),
    verification_uri: string({ format: "uri" }),
    verification_uri_complete: string({ format: "uri" }),
    expires_in: { type: "integer" },
    interval: { type: "integer" },
  }),
  DeviceToken: object({
    access_token: string({ description: "The device agent's API key (spt_…), returned once" }),
    token_type: string({ enum: ["Bearer"] }),
    actor: ref("Actor"),
    organization: ref("Organization"),
  }),
  DeviceTokenError: object({
    error: string({
      enum: ["invalid_request", "authorization_pending", "slow_down", "expired_token", "access_denied", "invalid_grant"],
    }),
  }),
  DeviceRequest: object({
    userCode: string(),
    clientName: string(),
    status: string({ enum: ["pending", "approved", "denied", "consumed"] }),
    expiresAt: string({ format: "date-time" }),
  }),
  DeviceApproveInput: object({ orgSlug: string() }),
};

const json = (schema: string) => ({ content: { "application/json": { schema: ref(schema) } } });
const ok = (description: string, schema: string) => ({ description, ...json(schema) });
const errors = {
  "400": { description: "Invalid input", ...json("Error") },
  "401": { description: "Missing or invalid credentials", ...json("Error") },
  "403": { description: "Not allowed", ...json("Error") },
  "404": { description: "Not found (also for organizations you are not a member of)", ...json("Error") },
  "409": { description: "Conflict: already exists, or a document saved since your baseVersion", ...json("Error") },
  "429": { description: "Rate-limited (agent comment loop guards, per-IP limits on public endpoints)", ...json("Error") },
};
const githubOff = { description: "The server has no GitHub App configured (not_configured)", ...json("Error") };
const githubDown = { description: "GitHub couldn't be reached or refused the request (github_unavailable)", ...json("Error") };
const rateLimited = (description: string) => ({ "429": { description, ...json("Error") } });
const invitationLimits = rateLimited(
  "Rate-limited: more than 20 invitation requests a minute from this client IP, or 10 from this user",
);
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const orgSlug = pathParam("orgSlug", "Organization slug");
const projectKey = pathParam("projectKey", 'Project key, e.g. "SPI"');
const repoOwner = pathParam("owner", 'GitHub owner of the repo, e.g. "pipisasa"');
const repoName = pathParam("name", 'Repo name, e.g. "spider-tracker"');
const taskKey = pathParam("taskKey", 'Task key, e.g. "SPI-12"');
const installationId = pathParam("installationId", "GitHub's installation id");
const userCode = pathParam("userCode", 'Code shown by spider login, e.g. "WDJB-MJHT"');
const body = (schema: string) => ({ required: true, ...json(schema) });
/** RFC 8628 endpoints accept JSON or form-encoded bodies. */
const jsonOrForm = (schema: string) => ({
  "application/json": { schema: ref(schema) },
  "application/x-www-form-urlencoded": { schema: ref(schema) },
});

const paths = {
  "/health": {
    get: { operationId: "health", summary: "Liveness, with the oldest supported CLI version", security: [], responses: { "200": { description: "OK" } } },
  },
  "/health/ready": {
    get: { operationId: "ready", summary: "Readiness: the database answers", security: [], responses: { "200": { description: "OK" } } },
  },
  "/auth/providers": {
    get: {
      operationId: "authProviders",
      summary: "Sign-in methods enabled on this server",
      security: [],
      responses: { "200": ok("Enabled providers", "AuthProviders") },
    },
  },
  "/device/code": {
    post: {
      operationId: "startDeviceAuthorization",
      summary: "Start a spider login (RFC 8628 device authorization). Rate limited per client IP",
      security: [],
      requestBody: { required: false, content: jsonOrForm("DeviceCodeInput") },
      responses: { "200": ok("Device and user codes", "DeviceCode"), "429": errors["429"] },
    },
  },
  "/device/token": {
    post: {
      operationId: "pollDeviceToken",
      summary: "Poll until the login is approved; then returns the device agent's API key",
      security: [],
      requestBody: { required: true, content: jsonOrForm("DeviceTokenInput") },
      responses: {
        "200": ok("The device agent's key", "DeviceToken"),
        "400": { description: "Pending, slowed down, denied, expired or invalid (RFC 8628 error)", ...json("DeviceTokenError") },
      },
    },
  },
  "/github/setup": {
    get: {
      operationId: "githubSetup",
      summary:
        "Where GitHub returns after installing the App (browser, session cookie). Checks the signed state against the signed-in person and, with the OAuth code, that they can access the installation; then connects it and redirects to Settings → GitHub (?connected= or ?error=)",
      security: [{ sessionCookie: [] }],
      parameters: [
        { name: "installation_id", in: "query", schema: { type: "string" } },
        { name: "setup_action", in: "query", schema: { type: "string", enum: ["install", "update", "request"] } },
        { name: "state", in: "query", schema: { type: "string" } },
        { name: "code", in: "query", schema: { type: "string" }, description: "OAuth code (Request user authorization during installation)" },
      ],
      responses: {
        "302": { description: "Back to the web app" },
        "400": { description: "Invalid, expired or already used state (a state works once)" },
        "401": { description: "Not signed in" },
        "403": { description: "Started by someone else, or no longer an owner or admin" },
        "503": githubOff,
      },
    },
  },
  "/webhooks/github": {
    post: {
      operationId: "githubWebhook",
      summary:
        "The GitHub App's webhook (GitHub calls it; the signature is the credential). X-Hub-Signature-256 is checked over the raw body before parsing, and each X-GitHub-Delivery is handled once. Handles installation, installation_repositories and repository, and links branches, commits and pull requests to tasks from create, delete, push and pull_request (a pull_request event older than the stored PR changes nothing); ping and other events are recorded and ignored",
      security: [],
      parameters: [
        { name: "X-GitHub-Event", in: "header", required: true, schema: { type: "string" }, description: 'e.g. "installation"' },
        { name: "X-GitHub-Delivery", in: "header", required: true, schema: { type: "string" }, description: "The delivery's GUID" },
        {
          name: "X-Hub-Signature-256",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "sha256=<hex HMAC-SHA256 of the body with the webhook secret>",
        },
      ],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "GitHub's event payload" } } } },
      responses: {
        "200": {
          description: "Handled (processed), seen before (duplicate), or nothing to do (ignored)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: { status: string({ enum: ["processed", "ignored", "duplicate"] }) },
              },
            },
          },
        },
        "400": { description: "Missing headers, a body that isn't JSON, or a payload that doesn't match its event", ...json("Error") },
        "401": { description: "Missing or invalid signature (unauthorized)", ...json("Error") },
        "413": { description: "Body over 5 MiB (payload_too_large)", ...json("Error") },
        "503": githubOff,
      },
    },
  },
  "/v1/device/{userCode}": {
    parameters: [userCode],
    get: {
      operationId: "getDeviceRequest",
      summary: "A pending device login, for the approval page (browser sessions only)",
      responses: { "200": ok("Device request", "DeviceRequest"), ...errors },
    },
  },
  "/v1/device/{userCode}/approve": {
    parameters: [userCode],
    post: {
      operationId: "approveDevice",
      summary: "Approve a device login for one of your organizations (owners, admins and members; browser sessions only)",
      requestBody: body("DeviceApproveInput"),
      responses: { "204": { description: "Approved" }, ...errors },
    },
  },
  "/v1/device/{userCode}/deny": {
    parameters: [userCode],
    post: {
      operationId: "denyDevice",
      summary: "Deny a device login (browser sessions only)",
      responses: { "204": { description: "Denied" }, ...errors },
    },
  },
  "/v1/organizations": {
    post: {
      operationId: "createOrganization",
      summary: "Create an organization; you become its owner (browser sessions only)",
      requestBody: body("CreateOrganizationInput"),
      responses: { "201": ok("New membership", "Membership"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/events": {
    parameters: [orgSlug],
    get: {
      operationId: "streamEvents",
      summary: "Server-sent change events (ids and keys only; refetch through the normal routes)",
      responses: {
        "200": { description: "SSE stream of ready, ping and change events", content: { "text/event-stream": { schema: string() } } },
        ...errors,
      },
    },
  },
  "/v1/whoami": {
    get: {
      operationId: "whoami",
      summary: "The agent an API key acts as, and its organization",
      responses: { "200": ok("Current agent", "Membership"), ...errors },
    },
  },
  "/v1/me": {
    get: {
      operationId: "me",
      summary: "The signed-in person and their organizations (browser sessions only)",
      responses: { "200": ok("Current user", "Me"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/members": {
    parameters: [orgSlug],
    get: {
      operationId: "listMembers",
      summary: "List people and agents in the organization",
      parameters: [
        {
          name: "all",
          in: "query",
          schema: { type: "boolean" },
          description: "Include deactivated people and deleted agents (e.g. to name tasks' former assignees)",
        },
      ],
      responses: { "200": ok("Members", "ActorList"), ...errors },
    },
  },
  "/v1/invitations/preview": {
    post: {
      operationId: "previewInvitation",
      summary: "The organization and role an invitation code joins (browser sessions only)",
      requestBody: body("InvitationCodeInput"),
      responses: { "200": ok("Invitation preview", "InvitationPreview"), ...errors, ...invitationLimits },
    },
  },
  "/v1/invitations/accept": {
    post: {
      operationId: "acceptInvitation",
      summary: "Join an organization with an invitation code (browser sessions only)",
      requestBody: body("InvitationCodeInput"),
      responses: { "201": ok("New membership", "Membership"), ...errors, ...invitationLimits },
    },
  },
  "/v1/orgs/{orgSlug}/invitations": {
    parameters: [orgSlug],
    get: {
      operationId: "listInvitations",
      summary: "Active invitation codes and recently expired or revoked ones (owners and admins)",
      responses: { "200": ok("Invitations", "InvitationList"), ...errors },
    },
    post: {
      operationId: "createInvitation",
      summary: "Create an invitation code (owners and admins; only owners can invite admins)",
      requestBody: body("CreateInvitationInput"),
      responses: { "201": ok("Created invitation", "Invitation"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/invitations/{invitationId}": {
    parameters: [orgSlug, pathParam("invitationId", "Invitation id")],
    delete: {
      operationId: "revokeInvitation",
      summary: "Revoke an invitation code",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents": {
    parameters: [orgSlug],
    get: {
      operationId: "listAgents",
      summary: "Active agents with their owners; keys only for agents you can manage",
      responses: { "200": ok("Agents", "AgentList"), ...errors },
    },
    post: {
      operationId: "createAgent",
      summary: "Create an agent owned by you (people with owner, admin or member role; not guests or agent keys)",
      requestBody: body("CreateAgentInput"),
      responses: { "201": ok("Created agent", "Agent"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents/me": {
    parameters: [orgSlug],
    patch: {
      operationId: "updateAgentMe",
      summary: "An agent changes its own name, handle or description (agent API keys)",
      requestBody: body("UpdateAgentInput"),
      responses: { "200": ok("Updated agent", "Agent"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agent-invites": {
    parameters: [orgSlug],
    get: {
      operationId: "listAgentInvites",
      summary: "Unused agent invites for agents you can manage (recently expired ones included)",
      responses: { "200": ok("Agent invites", "AgentInviteList"), ...errors },
    },
    post: {
      operationId: "createAgentInvite",
      summary: "Create a pending agent limited to some projects, with a one-time setup code (people who can create agents)",
      requestBody: body("CreateAgentInviteInput"),
      responses: { "201": ok("Created invite", "CreatedAgentInvite"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agent-invites/{inviteId}": {
    parameters: [orgSlug, pathParam("inviteId", "Agent invite id")],
    delete: {
      operationId: "revokeAgentInvite",
      summary: "Revoke an unused agent invite and remove its pending agent",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/agent-invites/accept": {
    post: {
      operationId: "acceptAgentInvite",
      summary:
        "Accept an agent invite without signing in (the code is the credential): activates the agent and returns its first API key. `code` may be the invite link. Rate limited per client IP",
      security: [],
      requestBody: body("AcceptAgentInviteInput"),
      responses: {
        "201": ok("The agent's key and scope", "AcceptedAgentInvite"),
        ...errors,
        ...rateLimited(
          "Rate-limited: more than 10 attempts a minute from this client IP, or more than 100 invalid codes an hour across all clients",
        ),
      },
    },
  },
  "/v1/orgs/{orgSlug}/agents/{agentId}": {
    parameters: [orgSlug, pathParam("agentId", "Agent actor id")],
    patch: {
      operationId: "updateAgent",
      summary: "Change an agent's name, handle or description (its owner, or owners and admins)",
      requestBody: body("UpdateAgentInput"),
      responses: { "200": ok("Updated agent", "Agent"), ...errors },
    },
    delete: {
      operationId: "deleteAgent",
      summary: "Deactivate an agent and revoke its keys; its history and assignments stay",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/agents/{agentId}/keys": {
    parameters: [orgSlug, pathParam("agentId", "Agent actor id")],
    post: {
      operationId: "createApiKey",
      summary: "Issue an API key for an agent you can manage; the secret is returned only once",
      requestBody: body("CreateApiKeyInput"),
      responses: { "201": ok("Created key", "CreatedApiKey"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/api-keys/{keyId}": {
    parameters: [orgSlug, pathParam("keyId", "API key id")],
    delete: {
      operationId: "revokeApiKey",
      summary: "Revoke a key of an agent you can manage",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects": {
    parameters: [orgSlug],
    get: {
      operationId: "listProjects",
      summary: "List projects",
      parameters: [
        { name: "archived", in: "query", schema: { type: "boolean" }, description: "Include archived projects" },
      ],
      responses: { "200": ok("Projects", "ProjectList"), ...errors },
    },
    post: {
      operationId: "createProject",
      summary: "Create a project with the default workflow of every task kind (owners, admins and their agents)",
      requestBody: body("CreateProjectInput"),
      responses: { "201": ok("Created project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "getProject",
      summary: "Get a project with its workflows (archived ones too)",
      responses: { "200": ok("Project", "ProjectDetail"), ...errors },
    },
    patch: {
      operationId: "updateProject",
      summary:
        "Change a project's name, description, rules document or status automation from pull requests (owners, admins and their agents); the key can't change. Setting rules notifies the project's agents",
      requestBody: body("UpdateProjectInput"),
      responses: { "200": ok("Updated project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/archive": {
    parameters: [orgSlug, projectKey],
    post: {
      operationId: "archiveProject",
      summary: "Archive a project: hidden from lists, no new tasks (owners, admins and their agents)",
      responses: { "200": ok("Archived project", "ProjectDetail"), ...errors },
    },
    delete: {
      operationId: "unarchiveProject",
      summary: "Restore an archived project (owners, admins and their agents)",
      responses: { "200": ok("Restored project", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/statuses": {
    parameters: [orgSlug, projectKey],
    post: {
      operationId: "createStatus",
      summary: "Add a status to one kind's workflow (owners, admins and their agents)",
      description: "Appended unless `position` is given; names are unique per workflow, case-insensitively (409). The category can't change later.",
      requestBody: body("CreateStatusInput"),
      responses: { "201": ok("The project with its workflows", "ProjectDetail"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/statuses/{statusId}": {
    parameters: [orgSlug, projectKey, pathParam("statusId", "Status id")],
    patch: {
      operationId: "updateStatus",
      summary: "Rename, recolor or move a status within its workflow (owners, admins and their agents)",
      requestBody: body("UpdateStatusInput"),
      responses: { "200": ok("The project with its workflows", "ProjectDetail"), ...errors },
    },
    delete: {
      operationId: "deleteStatus",
      summary: "Delete a status after moving its tasks to another status of the same workflow (owners, admins and their agents)",
      description:
        "Its tasks (deleted ones too) go to the end of `moveTo`'s column; completedAt is set or cleared when they close or reopen. " +
        "Refused (400) when the workflow would be left without an open status (not done or canceled) or without a done status.",
      parameters: [
        { name: "moveTo", in: "query", required: true, schema: { type: "string", format: "uuid" }, description: "The status to move its tasks to" },
      ],
      responses: { "200": ok("The project and how many tasks moved", "DeletedStatus"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/tasks": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listTasks",
      summary: "List a project's tasks in board order, optionally filtered",
      description:
        "Repeat a parameter for several values. Statuses, assignees and priorities match any of their values; " +
        "a task must carry every `tag` (or any of them with `tagMatch=any`); parameters combine with AND. " +
        "Missing or out-of-scope projects are 404s; unknown statuses, members and tags are 400s.",
      parameters: [
        { name: "kind", in: "query", schema: ref("TaskKind"), description: "Only tasks of this kind; status names then match its workflow only" },
        {
          name: "status",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description:
            'Status id, name or category ("In Progress", "in_progress"), case-insensitive; without `kind`, matched in every workflow',
        },
        {
          name: "assignee",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description:
            'Actor id or handle (deactivated ones too), "me", "mine" (you and your agents; for an agent key, ' +
            "its owner and the owner's agents, deleted ones too), or \"none\" for unassigned tasks",
        },
        {
          name: "tag",
          in: "query",
          schema: { type: "array", items: { type: "string" } },
          description: "Tag name, case-insensitive; the task must have all of them (see tagMatch)",
        },
        {
          name: "tagMatch",
          in: "query",
          schema: { type: "string", enum: ["all", "any"], default: "all" },
          description: "all: the task has every `tag`; any: at least one",
        },
        {
          name: "priority",
          in: "query",
          schema: { type: "array", items: { type: "integer", minimum: 0, maximum: 4 } },
          description: "0 none, 1 urgent, 2 high, 3 medium, 4 low",
        },
        { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive text in the title" },
        { name: "parent", in: "query", schema: { type: "string" }, description: 'Direct sub-tasks of this task key, e.g. "SPI-3"' },
        {
          name: "overdue",
          in: "query",
          schema: { type: "boolean" },
          description: "true: only tasks whose targetDate is before today (the server's UTC date) and whose status isn't done or canceled",
        },
      ],
      responses: { "200": ok("Tasks", "TaskList"), ...errors },
    },
    post: {
      operationId: "createTask",
      summary: "Create a task",
      requestBody: body("CreateTaskInput"),
      responses: { "201": ok("Created task", "Task"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/presence": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listPresence",
      summary:
        "Agents working on the project's tasks right now: they acted on a task (activity log) or read it through the API, CLI or MCP within the last 10 minutes",
      responses: { "200": ok("Active agents per task", "PresenceList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/views": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listSavedViews",
      summary: "The project's shared saved views plus your own",
      responses: { "200": ok("Saved views", "SavedViewList"), ...errors },
    },
    post: {
      operationId: "createSavedView",
      summary: "Save a filter set (personal unless shared); not for guests",
      requestBody: body("CreateSavedViewInput"),
      responses: { "201": ok("Created view", "SavedView"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/views/{viewId}": {
    parameters: [orgSlug, projectKey, pathParam("viewId", "Saved view id")],
    patch: {
      operationId: "updateSavedView",
      summary: "Rename or change a view (its owner, or organization owners and admins)",
      requestBody: body("UpdateSavedViewInput"),
      responses: { "200": ok("Updated view", "SavedView"), ...errors },
    },
    delete: {
      operationId: "deleteSavedView",
      summary: "Delete a view (its owner, or organization owners and admins)",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/bulk-update": {
    parameters: [orgSlug],
    post: {
      operationId: "bulkUpdateTasks",
      summary: "Update several tasks at once, by keys or a filter (at most 100)",
      description:
        "Pass `keys` (any projects) or `filter` (one project; the same filters as listing tasks, plus `parent`), and `set`: " +
        "`status` (id, name or category, matched in each task's own project), `priority`, `assigneeIds`, `tagIds` (both replace the lists), `parentId`, `startDate`, `targetDate` (null clears; start ≤ target), `noCode`, `milestoneId` (a milestone of each task's own project; null takes it out). " +
        "Each task is updated on its own with the same permission and agent-scope checks as PATCH /tasks/{taskKey}; " +
        "a task that fails (missing, out of scope, unknown status, …) is reported in `results` without stopping the others, so the response is 200. " +
        "`dryRun: true` reports the outcomes without changing anything. More than 100 keys, or a filter matching more than 100 tasks, is a 400 and changes nothing.",
      requestBody: body("BulkUpdateTasksInput"),
      responses: { "200": ok("One result per task", "BulkUpdateTasksResult"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "getTask",
      summary: "Get a task",
      responses: { "200": ok("Task", "Task"), ...errors },
    },
    patch: {
      operationId: "updateTask",
      summary: "Update a task; send only the fields to change",
      requestBody: body("UpdateTaskInput"),
      responses: { "200": ok("Updated task", "Task"), ...errors },
    },
    delete: {
      operationId: "deleteTask",
      summary: "Delete a task",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/subtasks": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "listSubtasks", summary: "Direct sub-tasks of a task", responses: { "200": ok("Sub-tasks, each with its own status", "SubtaskList"), ...errors } },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/relations": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "listRelations", summary: "Links to other tasks, from this task's point of view", responses: { "200": ok("Relations", "RelationList"), ...errors } },
    post: {
      operationId: "addRelation",
      summary: "Link this task to another (blocks, blocked_by, relates, duplicates, duplicated_by)",
      requestBody: body("RelationInput"),
      responses: { "201": ok("Created link", "Relation"), ...errors },
    },
    delete: {
      operationId: "removeRelation",
      summary: "Remove a link",
      parameters: [
        { name: "kind", in: "query", required: true, schema: { type: "string", enum: relationKindSchema.options } },
        { name: "task", in: "query", required: true, schema: { type: "string" }, description: "The other task's key" },
      ],
      responses: { "204": { description: "Removed" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/duplicate": {
    parameters: [orgSlug, taskKey],
    post: {
      operationId: "markDuplicate",
      summary:
        "Mark as a duplicate of another task in one step: link it (duplicates), move it to the project's first canceled status and comment \"Duplicate of KEY\". A repeat changes nothing; self, cycles and a second original are refused",
      requestBody: body("MarkDuplicateInput"),
      responses: { "200": ok("The task, canceled", "Task"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/activity": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listTaskActivity",
      summary: "A task's history from the activity log, oldest first",
      responses: { "200": ok("Activity", "ActivityList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/git": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "getTaskGit",
      summary:
        "Branches, commits and pull requests linked to the task from GitHub: a branch named after it, commits and PRs that mention it (only in repos attached to its project)",
      responses: { "200": ok("Git links", "TaskGit"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/pull-request": {
    parameters: [orgSlug, taskKey],
    post: {
      operationId: "openPullRequest",
      summary:
        "Open the task's pull request on GitHub as the App (installation token) for a branch already pushed, and link it to the task at once (ST-87). " +
        "The repo is the one named, or the only one attached to the task's project; head defaults to the task's branch, base to the repo's default branch. " +
        'The title defaults to "<task title> (KEY)"; the body always closes the task ("Closes KEY"), so status automation moves it',
      requestBody: { required: false, ...json("OpenPullRequestInput") },
      responses: {
        "201": ok("The pull request, as linked to the task", "OpenedPullRequest"),
        ...errors,
        "409": { description: "A pull request is already open for the branch: error.url is its address", ...json("Error") },
        "502": githubDown,
        "503": githubOff,
      },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/backlinks": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listTaskBacklinks",
      summary: "Documents mentioning the task ([[KEY-1]] or a plain KEY-1), most recently updated first; not the task's own documents",
      responses: { "200": ok("Mentioning documents", "DocumentList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tasks/{taskKey}/comments": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listComments",
      summary: "Comments on a task, oldest first",
      responses: { "200": ok("Comments", "CommentList"), ...errors },
    },
    post: {
      operationId: "addComment",
      summary: "Comment on a task; @mentions, replies and assignees are notified",
      requestBody: body("CreateCommentInput"),
      responses: { "201": ok("Created comment", "Comment"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tags": {
    parameters: [orgSlug],
    get: { operationId: "listTags", summary: "The organization's tags", responses: { "200": ok("Tags", "TagList"), ...errors } },
    post: {
      operationId: "createTag",
      summary: "Create a tag",
      requestBody: body("CreateTagInput"),
      responses: { "201": ok("Created tag", "Tag"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/tags/{tagId}": {
    parameters: [orgSlug, pathParam("tagId", "Tag id")],
    delete: {
      operationId: "deleteTag",
      summary: "Delete a tag (owners and admins); it is removed from every task",
      responses: { "204": { description: "Deleted" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/repos": {
    parameters: [orgSlug],
    get: {
      operationId: "listRepos",
      summary: "The organization's repos with their apps and projects (a project-scoped agent: only its projects' repos)",
      parameters: [{ name: "project", in: "query", schema: { type: "string" }, description: "Only the repos attached to this project key" }],
      responses: { "200": ok("Repos", "RepoList"), ...errors },
    },
    post: {
      operationId: "createRepo",
      summary:
        "Add a repo by its GitHub remote (URL or owner/name), optionally attached to projects (owners, admins and their agents; a project-scoped agent must attach it to one of its projects). 409 if it exists; a project-scoped agent that can't see it is told to ask an owner or admin to attach it",
      requestBody: body("CreateRepoInput"),
      responses: { "201": ok("Created repo", "Repo"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/repos/{owner}/{name}": {
    parameters: [orgSlug, repoOwner, repoName],
    get: { operationId: "getRepo", summary: "A repo with its apps and projects", responses: { "200": ok("Repo", "Repo"), ...errors } },
    patch: {
      operationId: "updateRepo",
      summary: "Change a repo's remote (after a rename) or default branch (owners, admins and their agents; a project-scoped agent only when the repo is attached to none but its projects, else 403)",
      requestBody: body("UpdateRepoInput"),
      responses: { "200": ok("Updated repo", "Repo"), ...errors },
    },
    delete: {
      operationId: "deleteRepo",
      summary: "Remove a repo with its apps and project links (owners, admins and their agents; a project-scoped agent only when the repo is attached to none but its projects, else 403)",
      responses: { "204": { description: "Removed" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/repos/{owner}/{name}/apps": {
    parameters: [orgSlug, repoOwner, repoName],
    post: {
      operationId: "createApp",
      summary: "Add an app to a repo: folder, shared packages, versioning (default semver), environments in deploy order (owners, admins and their agents; a project-scoped agent only when the repo is attached to none but its projects, else 403). 409 if the name is taken",
      requestBody: body("CreateAppInput"),
      responses: { "201": ok("Created app", "App"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/repos/{owner}/{name}/apps/{app}": {
    parameters: [orgSlug, repoOwner, repoName, pathParam("app", 'App name, e.g. "web"')],
    patch: {
      operationId: "updateApp",
      summary: "Rename an app or change its paths, versioning or environments (owners, admins and their agents; a project-scoped agent only when the repo is attached to none but its projects, else 403)",
      requestBody: body("UpdateAppInput"),
      responses: { "200": ok("Updated app", "App"), ...errors },
    },
    delete: { operationId: "deleteApp", summary: "Remove an app (owners, admins and their agents; a project-scoped agent only when the repo is attached to none but its projects, else 403)", responses: { "204": { description: "Removed" }, ...errors } },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/repos": {
    parameters: [orgSlug, projectKey],
    post: {
      operationId: "attachRepo",
      summary: "Attach a repo to the project (owners, admins and their agents); attaching it again changes nothing",
      requestBody: body("AttachRepoInput"),
      responses: { "200": ok("The repo", "Repo"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/repos/{owner}/{name}": {
    parameters: [orgSlug, projectKey, repoOwner, repoName],
    delete: {
      operationId: "detachRepo",
      summary: "Detach a repo from the project; detaching one that isn't attached changes nothing",
      responses: { "200": ok("The repo", "Repo"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/milestones": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listMilestones",
      summary:
        "The project's roadmap: its milestones (tasks of kind milestone) by target date, then start date (undated last), with progress, tasks and the releases that shipped them",
      parameters: [
        { name: "status", in: "query", schema: { type: "array", items: { type: "string" } }, description: "Status ids, names or categories of the milestone workflow; repeat for several" },
      ],
      responses: { "200": ok("Milestones", "MilestoneList"), ...errors },
    },
    post: {
      operationId: "createMilestone",
      summary: "Create a milestone: a task of kind milestone (Planned unless statusId), goal and Done when in the description. Tasks join it with PATCH /tasks/{key} { milestoneId }",
      requestBody: body("CreateMilestoneInput"),
      responses: { "201": ok("Created milestone", "Milestone"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/milestones/{taskKey}": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "getMilestone", summary: "A milestone with its progress, tasks and releases", responses: { "200": ok("Milestone", "Milestone"), ...errors } },
  },
  "/v1/orgs/{orgSlug}/projects/{projectKey}/releases": {
    parameters: [orgSlug, projectKey],
    get: {
      operationId: "listReleases",
      summary: "The project's releases (tasks of kind release) in board order, with repos, apps and versions, and included tasks",
      parameters: [
        { name: "status", in: "query", schema: { type: "array", items: { type: "string" } }, description: "Status ids, names or categories of the release workflow; repeat for several" },
        { name: "app", in: "query", schema: { type: "string" }, description: 'Only releases shipping this app, e.g. "web"' },
      ],
      responses: { "200": ok("Releases", "ReleaseList"), ...errors },
    },
    post: {
      operationId: "createRelease",
      summary:
        "Create a release: a task of kind release (its title is usually the version) linking repos and apps with a version each (in the app's versioning), optionally including Done tasks of any project",
      requestBody: body("CreateReleaseInput"),
      responses: { "201": ok("Created release", "Release"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/releases/{taskKey}": {
    parameters: [orgSlug, taskKey],
    get: { operationId: "getRelease", summary: "A release with its repos, apps and included tasks", responses: { "200": ok("Release", "Release"), ...errors } },
    patch: {
      operationId: "updateRelease",
      summary: "Replace a release's repos or apps (with their versions); apps' repos stay linked. Status changes go through PATCH /tasks/{taskKey}: Released ships the included tasks",
      requestBody: body("UpdateReleaseInput"),
      responses: { "200": ok("Updated release", "Release"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/releases/{taskKey}/tasks": {
    parameters: [orgSlug, taskKey],
    post: {
      operationId: "addToRelease",
      summary:
        "Add Done tasks (any project) to a release that isn't Released or Canceled; one release per task (409 if in another), adding again changes nothing; all or nothing",
      requestBody: body("ReleaseTasksInput"),
      responses: { "200": ok("The release", "Release"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/releases/{taskKey}/tasks/{includedKey}": {
    parameters: [orgSlug, taskKey, pathParam("includedKey", 'The included task\'s key, e.g. "SPI-3"')],
    delete: {
      operationId: "removeFromRelease",
      summary: "Take a task out of a release that hasn't shipped",
      responses: { "200": ok("The release", "Release"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/releases/{taskKey}/changelog": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "getReleaseChangelog",
      summary:
        "The release's changelog, generated from its included tasks of the release's own project (title plus the \"What changed\" part of each handoff note; other projects' tasks are left out), grouped by app for a one-app release, and how the description's changelog block compares",
      responses: { "200": ok("Changelog", "ReleaseChangelog"), ...errors },
    },
    post: {
      operationId: "writeReleaseChangelog",
      summary:
        "Write the generated changelog into the release's description: replace its changelog block or append one, keeping the rest. taskApps (task key → app names) groups it by app; a block edited by hand is 409 unless force. A project-scoped agent gets 403 when the release includes tasks outside its projects",
      requestBody: body("ReleaseChangelogInput"),
      responses: { "200": ok("Written changelog", "ReleaseChangelog"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/releases/{taskKey}/deployments": {
    parameters: [orgSlug, taskKey],
    get: {
      operationId: "listDeployments",
      summary: "The release's deployments (app × environment, commit, who, when), newest first",
      parameters: [
        { name: "app", in: "query", schema: { type: "string" }, description: 'Only this app, e.g. "web"' },
        { name: "environment", in: "query", schema: { type: "string" }, description: 'Only this environment, e.g. "prod"' },
      ],
      responses: { "200": ok("Deployments", "DeploymentList"), ...errors },
    },
    post: {
      operationId: "recordDeployment",
      summary:
        "Record that one of the release's apps was deployed to one of the app's environments at a commit (spider release deploy). The first deployment moves a Planned release to On staging (as the @spider bot); Released stays manual and needs every app with environments deployed to its last one. A canceled release takes none",
      requestBody: body("RecordDeploymentInput"),
      responses: { "201": ok("Recorded deployment", "RecordedDeployment"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/release-candidates": {
    parameters: [orgSlug],
    get: {
      operationId: "listReleaseCandidates",
      summary: "Done tasks with code in no release and not shipped, most recently finished first (at most 200)",
      parameters: [
        { name: "project", in: "query", schema: { type: "string" }, description: "Only this project's tasks" },
        { name: "release", in: "query", schema: { type: "string" }, description: "For this release (a task key)" },
      ],
      responses: { "200": ok("Candidates", "TaskList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/github": {
    parameters: [orgSlug],
    get: {
      operationId: "getGithub",
      summary: "Whether this server has a GitHub App, and the organization's installations (ST-82)",
      responses: { "200": ok("GitHub status", "GithubStatus"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/github/install": {
    parameters: [orgSlug],
    post: {
      operationId: "startGithubInstall",
      summary:
        "The GitHub page that installs the App, with a signed state valid for 15 minutes (owners and admins, browser sessions only). GitHub returns to /github/setup",
      responses: { "200": ok("Install URL", "GithubInstallUrl"), ...errors, "503": githubOff },
    },
  },
  "/v1/orgs/{orgSlug}/github/installations/{installationId}/sync": {
    parameters: [orgSlug, installationId],
    post: {
      operationId: "syncGithubInstallation",
      summary:
        "Fetch the installation and its repositories from GitHub again: attach repos the organization has, add new ones, release those no longer granted (owners, admins and their unscoped agents)",
      responses: { "200": ok("The installation", "GithubInstallation"), ...errors, "502": githubDown, "503": githubOff },
    },
  },
  "/v1/orgs/{orgSlug}/github/installations/{installationId}": {
    parameters: [orgSlug, installationId],
    delete: {
      operationId: "disconnectGithubInstallation",
      summary: "Forget an installation; its repos stay, without it. The App stays installed on GitHub (see settingsUrl)",
      responses: { "204": { description: "Disconnected" }, ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents": {
    parameters: [orgSlug],
    get: {
      operationId: "listDocuments",
      summary: "Documents without content, most recently updated first",
      parameters: [
        { name: "project", in: "query", schema: { type: "string" }, description: "A project's documents, including its tasks'" },
        { name: "task", in: "query", schema: { type: "string" }, description: "A task's documents" },
      ],
      responses: { "200": ok("Documents", "DocumentList"), ...errors },
    },
    post: {
      operationId: "createDocument",
      summary: "Create a document: organization-wide, or in a project or task (by key)",
      requestBody: body("CreateDocumentInput"),
      responses: { "201": ok("Created document", "Document"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/graph": {
    parameters: [orgSlug],
    get: {
      operationId: "getDocumentGraph",
      summary:
        "Documents as a graph: visible documents, the tasks and projects they sit in or link to, and their links ([[Title]], [[doc:<id>]], [[KEY-1]] and plain task keys)",
      responses: { "200": ok("Graph", "DocumentGraph"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: { operationId: "getDocument", summary: "A document with its content", responses: { "200": ok("Document", "Document"), ...errors } },
    patch: {
      operationId: "updateDocument",
      summary:
        "Save a new version; 409 if the document was saved since baseVersion. A rename rewrites [[Old title]] links in the documents linking here that you can edit (see relinked)",
      requestBody: body("UpdateDocumentInput"),
      responses: { "200": ok("Updated document", "UpdatedDocument"), ...errors },
    },
    delete: { operationId: "deleteDocument", summary: "Delete a document", responses: { "204": { description: "Deleted" }, ...errors } },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/edit": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    post: {
      operationId: "editDocument",
      summary:
        "Partial edits saved as one new version: replace a fragment ({ old, new, all? }; it must occur once unless all), append ({ append }), or replace a Markdown section's body ({ section: \"## Heading\", content }). With baseVersion, 409 if saved since; without, applies to the current version. 409 when a fragment or section isn't there, 400 when ambiguous",
      requestBody: body("EditDocumentInput"),
      responses: { "200": ok("Edited document", "Document"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/move": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    post: {
      operationId: "moveDocument",
      summary: "Move a document to a project (key), or make it organization-wide (null); keeps id and versions, detaches it from a task",
      requestBody: body("MoveDocumentInput"),
      responses: { "200": ok("Moved document", "Document"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/backlinks": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "listDocumentBacklinks",
      summary: "Documents linking here with [[its title]] or [[doc:<its id>]], most recently updated first",
      responses: { "200": ok("Linking documents", "DocumentList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/versions": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "listDocumentVersions",
      summary: "Saved versions, newest first, without content",
      responses: { "200": ok("Versions", "DocumentVersionList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/versions/{version}": {
    parameters: [orgSlug, pathParam("documentId", "Document id"), pathParam("version", "Version number")],
    get: { operationId: "getDocumentVersion", summary: "One saved version with its content", responses: { "200": ok("Version", "DocumentVersion"), ...errors } },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/diff": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "diffDocumentVersions",
      summary: "A line diff of two saved versions; without to, against the current one. 404 for a missing version",
      parameters: [
        { name: "from", in: "query", required: true, schema: { type: "integer", minimum: 1 }, description: "The older version" },
        { name: "to", in: "query", schema: { type: "integer", minimum: 1 }, description: "The newer version; defaults to the current one" },
      ],
      responses: { "200": ok("Diff", "DocumentDiff"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/comments": {
    parameters: [orgSlug, pathParam("documentId", "Document id")],
    get: {
      operationId: "listDocumentComments",
      summary: "Comments on a document, oldest first, with their quotes and outdated and resolved states",
      responses: { "200": ok("Comments", "DocumentCommentList"), ...errors },
    },
    post: {
      operationId: "addDocumentComment",
      summary:
        "Comment on a document, or on a fragment of it (quote: text in the current version; top-level comments only). Mentions, the author replied to, the document's author and the thread are notified",
      requestBody: body("CreateDocumentCommentInput"),
      responses: { "201": ok("Created comment", "DocumentComment"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/documents/{documentId}/comments/{commentId}": {
    parameters: [orgSlug, pathParam("documentId", "Document id"), pathParam("commentId", "Comment id")],
    patch: {
      operationId: "resolveDocumentComment",
      summary: "Mark a thread (a top-level comment) resolved, or reopen it; a repeat changes nothing",
      requestBody: body("ResolveDocumentCommentInput"),
      responses: { "200": ok("Comment", "DocumentComment"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/inbox": {
    parameters: [orgSlug],
    get: {
      operationId: "listInbox",
      summary: "The caller's notifications, oldest first; can wait for new items",
      parameters: [
        { name: "after", in: "query", schema: { type: "integer" }, description: "Only items with a larger id" },
        { name: "unread", in: "query", schema: { type: "boolean" }, description: "Only unread items" },
        { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
        { name: "wait", in: "query", schema: { type: "integer", maximum: 25 }, description: "Seconds to wait for a new item" },
        {
          name: "kinds",
          in: "query",
          schema: { type: "string" },
          description:
            "Comma-separated kinds to return (mention, assigned, comment, reply, rules, document_mention, document_comment, document_reply); default: the task kinds (all but rules and document_*)",
        },
      ],
      responses: { "200": ok("Inbox items", "InboxList"), ...errors },
    },
  },
  "/v1/orgs/{orgSlug}/inbox/read": {
    parameters: [orgSlug],
    post: {
      operationId: "markInboxRead",
      summary: "Mark items read, by ids or up to an id (only `kinds`, default the task kinds)",
      requestBody: body("MarkInboxReadInput"),
      responses: { "200": ok("Number of items marked", "MarkedCount"), ...errors },
    },
  },
  "/v1/api-keys/current": {
    delete: {
      operationId: "revokeCurrentApiKey",
      summary: "Revoke the API key this request is made with (spider logout)",
      responses: { "204": { description: "Revoked" }, ...errors },
    },
  },
};

export function openApiDocument(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Spider Tracker API",
      version: "1",
      description:
        'Agents authenticate with an API key ("Authorization: Bearer spt_…"); the web app uses its session cookie. ' +
        'API-key clients may send "X-Spider-Source: cli | mcp | api" to label their activity. ' +
        '/v1 and /mcp responses carry "X-Spider-Min-Cli: <version>", the oldest spider CLI this server supports.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "spt_…" },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description: "Browser session (prefixed with __Secure- over HTTPS)",
        },
      },
      schemas,
    },
  };
}
