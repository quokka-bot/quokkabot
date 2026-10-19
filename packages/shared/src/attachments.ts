import { z } from "zod";

export const MAX_MESSAGE_IMAGES = 8;
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 8000;
export const ImageMediaType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = z.infer<typeof ImageMediaType>;
export const AttachmentIds = z.array(z.uuid()).max(MAX_MESSAGE_IMAGES).refine(ids => new Set(ids).size === ids.length, "Attachment ids must be unique").default([]);
export const Attachment = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  mediaType: ImageMediaType,
  bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  width: z.number().int().min(1).max(MAX_IMAGE_SIDE),
  height: z.number().int().min(1).max(MAX_IMAGE_SIDE),
});
export type Attachment = z.infer<typeof Attachment>;
export const RunImage = z.object({
  mediaType: ImageMediaType,
  data: z.string().min(4).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(data => data.length % 4 === 0, "Expected padded base64"),
}).strict();
export type RunImage = z.infer<typeof RunImage>;
