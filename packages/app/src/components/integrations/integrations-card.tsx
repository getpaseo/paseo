// IntegrationsCard — settings card listing all integrations and their connection status
// Adapted from emdash's IntegrationsCard.tsx

import { useCallback, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, Plus } from "lucide-react-native";
import type { IntegrationId } from "@/types/kanban";
import {
  INTEGRATION_REGISTRY,
  DEFAULT_INTEGRATION_STATUS,
  type IntegrationStatusMap,
} from "@/types/kanban";

interface IntegrationsCardProps {
  statusMap?: IntegrationStatusMap;
  onConnect?: (integrationId: IntegrationId) => void;
  onDisconnect?: (integrationId: IntegrationId) => void;
}

export function IntegrationsCard({
  statusMap = DEFAULT_INTEGRATION_STATUS,
  onConnect,
  onDisconnect,
}: IntegrationsCardProps) {
  const { theme } = useUnistyles();

  return (
    <View style={cardStyles.container}>
      <View style={cardStyles.header}>
        <Text style={cardStyles.title}>Integrations</Text>
        <Text style={cardStyles.subtitle}>Connect external services and tools.</Text>
      </View>
      <View style={cardStyles.list}>
        {INTEGRATION_REGISTRY.map((integration) => {
          const isConnected = statusMap[integration.id] ?? false;
          return (
            <IntegrationRow
              key={integration.id}
              name={integration.name}
              description={integration.description}
              isConnected={isConnected}
              onPress={() =>
                isConnected ? onDisconnect?.(integration.id) : onConnect?.(integration.id)
              }
            />
          );
        })}
      </View>
    </View>
  );
}

function IntegrationRow({
  name,
  description,
  isConnected,
  onPress,
}: {
  name: string;
  description: string;
  isConnected: boolean;
  onPress?: () => void;
}) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      style={({ pressed, hovered }) => [
        cardStyles.row,
        hovered && cardStyles.rowHovered,
        pressed && cardStyles.rowPressed,
      ]}
      onPress={onPress}
    >
      <View style={cardStyles.rowContent}>
        <View style={cardStyles.iconPlaceholder}>
          <Text style={cardStyles.iconText}>{name.charAt(0)}</Text>
        </View>
        <View style={cardStyles.rowText}>
          <Text style={cardStyles.rowName}>{name}</Text>
          <Text style={cardStyles.rowDescription}>{description}</Text>
        </View>
      </View>
      <View>
        {isConnected ? (
          <View style={cardStyles.connectedBadge}>
            <Check size={14} color={theme.colors.foreground} />
          </View>
        ) : (
          <View style={cardStyles.connectButton}>
            <Plus size={14} color={theme.colors.foregroundMuted} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

const cardStyles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  header: {
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  list: {
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    padding: theme.spacing[4],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flex: 1,
  },
  iconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  connectedBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  connectButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
}));
