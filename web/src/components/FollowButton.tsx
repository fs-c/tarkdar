import { Locate, LocateFixed, Navigation } from "lucide-react";
import { cx } from "../ui";
import s from "./App.module.css";
import f from "./Floating.module.css";

interface Props {
  follow: boolean;
  /** Following and turning the map with the local player's view direction. */
  heading: boolean;
  /** Off: starts following. Following: switches turning with the view direction. */
  onClick: () => void;
}

/** Off: flies to the local player and follows. Following: turns the map with their view
 *  direction, or not. Moving the map by hand (or F) stops following. */
export function FollowButton({ follow, heading, onClick }: Props) {
  return (
    <button
      className={cx(f.surface, f.round, f.corner, s.follow)}
      aria-pressed={follow}
      data-heading={heading}
      title={
        !follow
          ? "Follow the local player (F)"
          : heading
              ? "Following your view direction: click for a fixed direction. Drag the map or press F to stop following."
              : "Following you: click to follow your view direction too. Drag the map or press F to stop following."
      }
      onClick={onClick}
    >
      {heading ? <Navigation size={20} /> : follow ? <LocateFixed size={20} /> : <Locate size={20} />}
    </button>
  );
}
