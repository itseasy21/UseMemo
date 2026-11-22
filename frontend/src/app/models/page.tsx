import type { Metadata } from "next";

import { ModelManager } from "@/components/models/ModelManager";

export const metadata: Metadata = { title: "Model Studio" };

export default function ModelsPage() {
  return <ModelManager />;
}
