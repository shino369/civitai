import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { TagTarget, TagType } from '@prisma/client';

const tagSchema = z.object({
  tag: z.string().transform((x) => x.toLowerCase().trim()),
  id: z.number().optional(),
  confidence: z.number(),
});
const bodySchema = z.object({
  id: z.number(),
  isValid: z.boolean(),
  tags: z.array(tagSchema).optional(),
});
const tagCache: Record<string, number> = {};

export default WebhookEndpoint(async function imageTags(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const bodyResults = bodySchema.safeParse(req.body);
  if (!bodyResults.success)
    return res
      .status(400)
      .json({ error: `Invalid body: ${bodyResults.error.flatten().fieldErrors}` });
  const { id: imageId, isValid, tags: incomingTags } = bodyResults.data;

  // If image is not valid, delete image
  if (!isValid) {
    try {
      await dbWrite.image.delete({ where: { id: imageId } });
    } catch {
      // Do nothing... it must already be gone
    }
    return res.status(200).json({ ok: true });
  }

  // Clear automated tags
  await dbWrite.tagsOnImage.deleteMany({
    where: { imageId, automated: true },
  });

  // If there are no tags, return
  if (!incomingTags || incomingTags.length === 0) return res.status(200).json({ ok: true });

  // De-dupe incoming tags and keep tag with highest confidence
  const tagMap: Record<string, (typeof incomingTags)[0]> = {};
  for (const tag of incomingTags) {
    if (!tagMap[tag.tag] || tagMap[tag.tag].confidence < tag.confidence) tagMap[tag.tag] = tag;
  }
  const tags = Object.values(tagMap);

  // Get Ids for tags
  const tagsToFind: string[] = [];
  for (const tag of tags) {
    tag.id = tagCache[tag.tag];
    if (!tag.id) tagsToFind.push(tag.tag);
  }

  // Get tags that we don't have cached
  if (tagsToFind.length > 0) {
    const foundTags = await dbWrite.tag.findMany({
      where: { name: { in: tagsToFind } },
      select: { id: true, name: true },
    });

    // Cache found tags and add ids to tags
    for (const tag of foundTags) tagCache[tag.name] = tag.id;
    for (const tag of tags) tag.id = tagCache[tag.tag];
  }

  // Add missing tags
  const newTags = tags.filter((x) => !x.id);
  if (newTags.length > 0) {
    await dbWrite.tag.createMany({
      data: newTags.map((x) => ({
        name: x.tag,
        type: TagType.Label,
        target: [TagTarget.Image, TagTarget.Post, TagTarget.Model],
      })),
    });
    const newFoundTags = await dbWrite.tag.findMany({
      where: { name: { in: newTags.map((x) => x.tag) } },
      select: { id: true, name: true },
    });
    for (const tag of newFoundTags) {
      tagCache[tag.name] = tag.id;
      const match = tags.find((x) => x.tag === tag.name);
      if (match) match.id = tag.id;
    }
  }

  // Add new automated tags to image
  try {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnImage" ("imageId", "tagId", "confidence", "automated")
      VALUES ${tags
        .filter((x) => x.id)
        .map((x) => `(${imageId}, ${x.id}, ${x.confidence}, true)`)
        .join(', ')}
      ON CONFLICT ("imageId", "tagId") DO UPDATE SET "confidence" = EXCLUDED."confidence";
    `);
  } catch (e: any) {
    const image = await dbWrite.image.findUnique({
      where: { id: imageId },
      select: { id: true },
    });
    if (!image) return res.status(404).json({ error: 'Image not found' });

    return res.status(500).json({ error: e.message });
  }

  try {
    // Mark image as scanned and set the nsfw field based on the presence of automated tags with type 'Moderation'
    await dbWrite.$executeRawUnsafe(`
      UPDATE "Image"
      SET
        "scannedAt" = NOW(),
        "nsfw" = EXISTS (
          SELECT 1
          FROM "TagsOnImage"
          JOIN "Tag" ON "TagsOnImage"."tagId" = "Tag"."id"
          WHERE
            "TagsOnImage"."imageId" = ${imageId} AND
            "TagsOnImage"."automated" = true AND
            "Tag"."type" = '${TagType.Moderation}'
        )
      WHERE "id" = ${imageId};
    `);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }

  res.status(200).json({ ok: true });
});
