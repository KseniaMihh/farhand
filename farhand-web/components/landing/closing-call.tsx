import Link from "next/link";
import { BROWSE, REGISTER } from "@/lib/landing-links";

export function ClosingCall() {
  return (
    <section className="bg-cream">
      <div className="mx-auto max-w-column px-4 pb-16 lg:pb-20">
        <div className="rounded-3xl bg-pine px-6 py-16 text-center lg:px-10 lg:py-20">
          <h2 className="mx-auto max-w-[22ch] font-serif text-page-title text-cream">
            What would you ask someone abroad to buy for you?
          </h2>

          <p className="mx-auto mt-4 max-w-[52ch] text-lead text-sage-tint">
            Posting a need costs nothing and commits you to nothing. The answers
            come from people who live where it is sold.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href={REGISTER.href} className="btn btn-offer no-underline">
              {REGISTER.label}
            </Link>
            <Link href={BROWSE.href} className="btn btn-secondary no-underline">
              {BROWSE.label}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
