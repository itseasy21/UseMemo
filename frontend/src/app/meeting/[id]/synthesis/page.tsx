import type { Metadata } from "next";

import { SynthesisCanvas } from "@/components/synthesis/SynthesisCanvas";
import { getMeeting, MEETING_IDS } from "@/lib/demo-data";

export const dynamicParams = false;

export function generateStaticParams() {
  return MEETING_IDS.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `${getMeeting(id).title} · Synthesis` };
}

export default async function SynthesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SynthesisCanvas meeting={getMeeting(id)} />;
}
