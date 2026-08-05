"use client";

import React from "react";
import { ActionButton } from "@/components/ui/action-button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n/client";
import { useUserSettings } from "@/lib/userSettings";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Save, Send } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useUpdateUserSettings } from "@karakeep/shared-react/hooks/users";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { zUpdateDigestSettingsSchema } from "@karakeep/shared/types/users";

import { SettingsSection } from "./SettingsPage";

function DigestConfigurationForm() {
  const { t } = useTranslation();

  const settings = useUserSettings();
  const { mutate: updateSettings, isPending: isUpdating } =
    useUpdateUserSettings({
      onSuccess: () => {
        toast({
          description: t("settings.info.user_settings.user_settings_updated"),
        });
      },
      onError: () => {
        toast({
          description: t("common.something_went_wrong"),
          variant: "destructive",
        });
      },
    });

  const form = useForm<z.infer<typeof zUpdateDigestSettingsSchema>>({
    resolver: zodResolver(zUpdateDigestSettingsSchema),
    values: settings
      ? {
          digestEnabled: settings.digestEnabled,
        }
      : undefined,
  });

  const api = useTRPC();
  const { mutate: triggerDigest, isPending: isTriggering } = useMutation(
    api.digest.triggerDigest.mutationOptions({
      onSuccess: () => {
        toast({
          description: t("settings.digest.toasts.digest_queued"),
        });
      },
      onError: () => {
        toast({
          description: t("common.something_went_wrong"),
          variant: "destructive",
        });
      },
    }),
  );

  return (
    <SettingsSection title={t("settings.digest.configuration.title")}>
      <Form {...form}>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((value) => {
            updateSettings(value);
          })}
        >
          <FormField
            control={form.control}
            name="digestEnabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel>
                    {t("settings.digest.configuration.enable_digest")}
                  </FormLabel>
                  <FormDescription>
                    {t(
                      "settings.digest.configuration.enable_digest_description",
                    )}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <div className="flex gap-2">
            <ActionButton
              type="submit"
              loading={isUpdating}
              className="items-center"
            >
              <Save className="mr-2 size-4" />
              {t("settings.digest.configuration.save_settings")}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              loading={isTriggering}
              className="items-center"
              onClick={() => triggerDigest()}
            >
              <Send className="mr-2 size-4" />
              {t("settings.digest.configuration.send_now")}
            </ActionButton>
          </div>
        </form>
      </Form>
    </SettingsSection>
  );
}

export default function DigestSettings() {
  return <DigestConfigurationForm />;
}
