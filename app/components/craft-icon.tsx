import type { ReactNode, SVGProps } from "react";

export type CraftIconName =
  | "add" | "arrow" | "attach" | "chat" | "chevron" | "close" | "code"
  | "document" | "edit" | "external" | "folder" | "knowledge" | "mail"
  | "mastery" | "memory" | "moon" | "pin" | "reply" | "search" | "send" | "shield"
  | "spark" | "stop" | "sun" | "trash";

type CraftIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & { name: CraftIconName; size?: number };

export function CraftIcon({ name, size = 18, className = "", ...props }: CraftIconProps) {
  const paths: Record<CraftIconName, ReactNode> = {
    add: <><path d="M5 10h10" /><path d="M10 5v10" /></>,
    arrow: <><path d="M4 10h11" /><path d="m11 6 4 4-4 4" /></>,
    attach: <path d="M7.2 10.8 12 6a2.1 2.1 0 0 1 3 3l-6 6a3.5 3.5 0 0 1-5-5l6.2-6.2" />,
    chat: <path d="M4 5.5c0-1 1-1.8 2-1.8h8c1.1 0 2 .8 2 1.8v5.8c0 1-.9 1.8-2 1.8H9l-3.6 2.7.8-2.7H6c-1 0-2-.8-2-1.8Z" />,
    chevron: <path d="m8 5 5 5-5 5" />,
    close: <><path d="m6 6 8 8" /><path d="m14 6-8 8" /></>,
    code: <><path d="m7.5 6-4 4 4 4" /><path d="m12.5 6 4 4-4 4" /><path d="m11.5 4-3 12" /></>,
    document: <><path d="M6 3.5h5l3 3V16H6Z" /><path d="M11 3.5V7h3" /><path d="M8 10h4M8 12.8h4" /></>,
    edit: <><path d="m5 14.8.7-3.2 6.8-6.8 2.7 2.7-6.8 6.8Z" /><path d="m11.5 5.8 2.7 2.7" /></>,
    external: <><path d="M9 5H5v10h10v-4" /><path d="M11 4h5v5M16 4l-7 7" /></>,
    folder: <path d="M3.5 6.2h5l1.5 1.6h6.5l-1.2 7.1H4.7Z" />,
    knowledge: <><path d="M10 5.2C8.5 3.8 6.3 3.6 4.5 4.4v10c1.8-.8 4-.6 5.5.8Z" /><path d="M10 5.2c1.5-1.4 3.7-1.6 5.5-.8v10c-1.8-.8-4-.6-5.5.8Z" /></>,
    mail: <><rect x="3.5" y="5" width="13" height="10" rx="1.5" /><path d="m4 6 6 5 6-5" /></>,
    mastery: <><path d="m10 2.8 2 5.2 5.2 2-5.2 2-2 5.2L8 12l-5.2-2L8 8Z" /><circle cx="10" cy="10" r="1.5" /></>,
    memory: <><path d="M7 5.2a3 3 0 0 1 5.6-1.4A3 3 0 0 1 15 8.6a3 3 0 0 1-1.2 5.7A3 3 0 0 1 8.4 16 3 3 0 0 1 5 12.6a3 3 0 0 1 .7-5.3A3 3 0 0 1 7 5.2Z" /><path d="M8 6.5c1.5.2 2.2 1 2.2 2.3M6.2 10c1.2-.6 2.5-.4 3.3.5M10.4 13.8c-.6-1.2-.4-2.4.5-3.2M12.5 6.7c-1 .8-1.2 2-.8 3" /></>,
    moon: <path d="M14.8 13.8A6.5 6.5 0 0 1 6.2 5.2a6.5 6.5 0 1 0 8.6 8.6Z" />,
    pin: <><path d="m7 4 6 1-1 3 2 2-4 1-3 5 .5-5L5 9l3-1Z" /><path d="m10 11-3 5" /></>,
    reply: <><path d="m8 5-5 5 5 5" /><path d="M4 10h6c4 0 6 2 6 5" /></>,
    search: <><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 4 4" /></>,
    send: <><path d="m3.5 10 13-6-4.6 12-2.5-4Z" /><path d="m9.4 12 7.1-8" /></>,
    shield: <path d="M10 3 4.5 5v4.2c0 3.5 2.2 6.3 5.5 7.8 3.3-1.5 5.5-4.3 5.5-7.8V5Z" />,
    spark: <><path d="M10 3v4M10 13v4M3 10h4M13 10h4" /><path d="m5 5 2 2m6 6 2 2m0-10-2 2m-6 6-2 2" /></>,
    stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1" />,
    sun: <><circle cx="10" cy="10" r="3" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" /></>,
    trash: <><path d="M5 6h10M8 3.5h4l1 2.5M6.5 6l.7 10h5.6l.7-10" /><path d="M9 8.5v5M11 8.5v5" /></>,
  };

  return <svg className={`craft-icon ${className}`} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
