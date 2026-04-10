import Store from "electron-store";

type NotificationPreferences = {
  soundEnabled: boolean;
  soundName: string;
};

const store = new Store<NotificationPreferences>({
  defaults: {
    soundEnabled: true,
    soundName: "Pop",
  },
});

export function getNotificationSettings() {
  return {
    getSound: (): string => store.get("soundName", "Pop"),
    setSound: (name: string): void => store.set("soundName", name),
    isSoundEnabled: (): boolean => store.get("soundEnabled", true),
    setSoundEnabled: (enabled: boolean): void => store.set("soundEnabled", enabled),
  };
}
