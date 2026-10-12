import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { acceptInvitation, meQuery, previewInvitation } from "@/lib/queries";
import type { InvitationPreviewDto } from "@repo/core/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

const errorMessage = (err: Error) =>
  err instanceof ApiError ? err.message : "Something went wrong";

/** Enter an invitation code, confirm the organization, join it. */
export function JoinOrganizationForm({
  initialCode = "",
  autoFocus,
}: {
  initialCode?: string;
  autoFocus?: boolean;
}) {
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<InvitationPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const check = useMutation({
    mutationFn: previewInvitation,
    onSuccess: (result) => {
      setError(null);
      setPreview(result);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const join = useMutation({
    mutationFn: acceptInvitation,
    onSuccess: async (membership) => {
      // Update the cache before navigating: the org route's guard reads memberships from it.
      queryClient.setQueryData(meQuery.queryKey, (me) =>
        me ? { ...me, memberships: [...me.memberships, membership] } : me,
      );
      await navigate({
        to: "/$orgSlug",
        params: { orgSlug: membership.organization.slug },
      });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const { mutate: checkCode } = check;
  useEffect(() => {
    if (initialCode) checkCode(initialCode);
  }, [initialCode, checkCode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    check.mutate(code);
  }

  if (preview) {
    const { organization, role, alreadyMember } = preview;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {alreadyMember ? (
            <>
              You're already a member of{" "}
              <span className="font-medium">{organization.name}</span>.
            </>
          ) : (
            <>
              Join <span className="font-medium">{organization.name}</span> as{" "}
              <span className="font-medium">{role}</span>?
            </>
          )}
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          {alreadyMember ? (
            <Button
              onClick={() =>
                void navigate({
                  to: "/$orgSlug",
                  params: { orgSlug: organization.slug },
                })
              }
            >
              Open {organization.name}
            </Button>
          ) : (
            <Button disabled={join.isPending} onClick={() => join.mutate(code)}>
              {join.isPending ? "Joining…" : "Join"}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setPreview(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          aria-label="Invitation code"
          placeholder="ABCD-EFGH"
          autoFocus={autoFocus}
          autoComplete="off"
          className="font-mono uppercase"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" disabled={check.isPending || !code.trim()}>
          {check.isPending ? "Checking…" : "Join"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
