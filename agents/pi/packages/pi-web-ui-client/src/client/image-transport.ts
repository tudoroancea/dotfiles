import { createContext } from "preact";
import type { ImageReference } from "../wire/schema.ts";

/** Host-neutral URL seam; opaque image ids are never displayed by the client. */
export const ImageUrlContext = createContext<(reference: ImageReference) => string>(() => "");
