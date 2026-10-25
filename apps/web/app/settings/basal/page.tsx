import type { Metadata } from "next";
import BasalSettings from "@/components/settings/BasalSettings";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.basal.title")} | Karakeep`,
  };
}

export default function BasalSettingsPage() {
  return <BasalSettings />;
}
