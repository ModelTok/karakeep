import { DigestQueue } from "@karakeep/shared-server";

import { authedProcedure, createRateLimitMiddleware, router } from "../index";

export const digestAppRouter = router({
  triggerDigest: authedProcedure
    .use(
      createRateLimitMiddleware({
        name: "digest.triggerDigest",
        windowMs: 60 * 60 * 1000, // 1 hour window
        maxRequests: 5, // Max 5 digest triggers per hour
      }),
    )
    .mutation(async ({ ctx }) => {
      await DigestQueue.enqueue({ userId: ctx.user.id });
    }),
});
