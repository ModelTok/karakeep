"use client";

import DigestSettings from "@/components/settings/DigestSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { useTranslation } from "@/lib/i18n/client";

export default function DigestPage() {
  const { t } = useTranslation();
  return (
    <SettingsPage
      title={t("settings.digest.page_title")}
      description={t("settings.digest.page_description")}
    >
      <DigestSettings />
    </SettingsPage>
  );
}
