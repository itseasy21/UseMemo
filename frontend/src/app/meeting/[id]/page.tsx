import type { Metadata } from "next";

import { MeetingStudio } from "@/components/meeting/MeetingStudio";
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
  return { title: `${getMeeting(id).title} · Studio` };
}

export default async function MeetingStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MeetingStudio meeting={getMeeting(id)} />;
}
