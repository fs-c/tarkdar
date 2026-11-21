import { useState } from "react";
import type { RecordingInfo } from "../model/protocol";
import { loadRecording } from "../stream/recordings";
import type { Timeline } from "../stream/timeline";

export interface Review {
  info: RecordingInfo;
  timeline: Timeline;
}

/**
 * The recording opened from the Raids view (the "review"), if any; otherwise the live raid is shown.
 * `showRaids` moves the Raids view between its list and the shown raid's timeline.
 */
export function useReplay(showRaids: (level: "list" | "timeline") => void) {
  const [review, setReview] = useState<Review | null>(null);
  const [loadingRecording, setLoadingRecording] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  const openRecording = (info: RecordingInfo) => {
    if (review?.info.name === info.name) return showRaids("timeline");
    setLoadingRecording(info.name);
    setRecordingError(null);
    loadRecording(info.name).then(
      (t) => {
        setReview({ info, timeline: t });
        setLoadingRecording(null);
        showRaids("timeline");
      },
      (e: unknown) => {
        setRecordingError(`Couldn't load ${info.name}: ${String(e)}`);
        setLoadingRecording(null);
      },
    );
  };
  /** Out of the replay (the caller also rewinds the playback and shows the Raids list). */
  const leave = () => setReview(null);

  return { review, loadingRecording, recordingError, openRecording, leave };
}
