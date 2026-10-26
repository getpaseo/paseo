import { createFileRoute } from "@tanstack/react-router";
import { alternativeRouteOptions } from "~/components/alternative-page";

export const Route = createFileRoute("/{-$locale}/alternatives/superset")(
  alternativeRouteOptions("superset"),
);
