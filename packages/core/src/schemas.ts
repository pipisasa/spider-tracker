import { z } from "zod";

// Shared between backend validation and web forms.

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "At least 2 characters")
  .max(40, "At most 40 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single dashes");

export const createOrganizationInput = z.object({
  name: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
  slug: slugSchema,
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationInput>;
