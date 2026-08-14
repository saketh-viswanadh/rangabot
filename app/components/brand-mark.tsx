type BrandMarkProps = {
  className?: string;
  large?: boolean;
};

function classNames(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}

/** The expressive primary mark is reserved for product identity surfaces. */
export function PrimaryBrandMark({ className, large = false }: BrandMarkProps) {
  return (
    <span
      className={classNames("primary-brand-mark", large && "primary-brand-mark-large", className)}
      aria-hidden="true"
    />
  );
}

/** The compact Goldie mark identifies assistant turns without repeating the app icon. */
export function ChatBrandMark({ className }: BrandMarkProps) {
  return <span className={classNames("chat-brand-mark", className)} aria-hidden="true" />;
}

/** A restrained accent for welcome thoughts and active local generation. */
export function ConversationSpark({ className }: BrandMarkProps) {
  return <span className={classNames("conversation-spark", className)} aria-hidden="true" />;
}
