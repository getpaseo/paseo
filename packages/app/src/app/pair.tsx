import { Redirect } from "expo-router";

// Pairing deep links (pandaos://pair/#offer=...) land here; OfferLinkListener in the root
// layout imports the offer from the raw URL, so this route only has to leave the screen.
export default function PairRoute() {
  return <Redirect href="/" />;
}
