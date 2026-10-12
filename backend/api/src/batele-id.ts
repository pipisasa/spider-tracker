import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

// Batele ID (api-v2.batele.plus/auth): public PKCE client, standard userinfo claims.
// Callback: <API_ORIGIN>/api/auth/callback/batele-id

interface BateleUserinfo {
  sub: string;
  name: string;
  preferred_username: string;
  email?: string;
  picture?: string;
}

/** Domain of the placeholder email given to Batele users who have none. */
export const BATELE_PLACEHOLDER_DOMAIN = "users.batele-id.invalid";

export function bateleIdProvider(clientId: string, issuer: string): GenericOAuthConfig {
  return {
    providerId: "batele-id",
    clientId,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    pkce: true,
    tokenEndpointAuth: { method: "none" },
    scopes: ["openid", "profile", "email"],
    getUserInfo: async (tokens) => {
      const res = await fetch(`${issuer}/oidc/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (!res.ok) return null;
      const profile = (await res.json()) as BateleUserinfo;
      return {
        id: profile.sub,
        name: profile.name,
        // Batele users may sign in by phone and have no email; Better Auth needs one.
        // `.invalid` is reserved, so the placeholder can never receive mail or match a real address.
        email: profile.email ?? `${profile.sub}@${BATELE_PLACEHOLDER_DOMAIN}`,
        emailVerified: false,
        image: profile.picture,
      };
    },
  };
}
