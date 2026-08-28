import z from 'zod';

const maximumItems = 256;
const maximumLength = 4_000;
const maximumReferenceLength = 512;
const maximumControlCodePoint = 31;
const deleteControlCodePoint = 127;
const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(maximumReferenceLength)
  .refine((value) => {
    const components = value.split('/');
    const hasControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= maximumControlCodePoint ||
        codePoint === deleteControlCodePoint
      );
    });
    return (
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.includes('\\') &&
      !hasControlCharacter &&
      components.every(
        (component) =>
          component.length > 0 && component !== '.' && component !== '..',
      )
    );
  }, 'must be a canonical repository-relative path');

const check = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('path'), path: repositoryPath }),
  z.strictObject({
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    kind: z.literal('jsonPointer'),
    path: repositoryPath,
    pointer: z.string().min(1).max(maximumReferenceLength).startsWith('/'),
  }),
  z.strictObject({
    kind: z.literal('symbol'),
    path: repositoryPath,
    symbol: z.string().min(1).max(maximumReferenceLength),
  }),
  z.strictObject({
    kind: z.literal('sourcePattern'),
    path: repositoryPath,
    rule: z.literal('versionLadder'),
  }),
  z.strictObject({
    kind: z.literal('contentHash'),
    path: repositoryPath,
    predecessorSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

const text = z.string().trim().min(1).max(maximumLength);

export const decisionContractArtifactSchema = z.strictObject({
  authoritativeEndState: text,
  decisionSource: text,
  ownedPaths: z.array(repositoryPath).min(1).max(maximumItems),
  rejectedAlternatives: z.array(text).min(1).max(maximumItems),
  requiredAbsent: z.array(check).min(1).max(maximumItems),
  requiredPresent: z.array(check).min(1).max(maximumItems),
  retainedBoundaries: z.array(text).max(maximumItems),
});

export type DecisionContractArtifact = z.infer<
  typeof decisionContractArtifactSchema
>;
export type DecisionContractCheck = z.infer<typeof check>;
