import { createFileRoute } from "@tanstack/react-router";
import { alternativeRouteOptions } from "~/components/alternative-page";

export const Route = createFileRoute("/alternatives/conductor")(
  alternativeRouteOptions("conductor"),
);
