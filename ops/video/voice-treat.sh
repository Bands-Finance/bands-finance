#!/bin/sh
# voice-treat.sh <in> <out.mp3>: a "recorded, not synthesised" treatment for a voice track: a little low-mid warmth,
# a presence dip, soft compression, a hint of room, a faint pink-noise air bed under it, then broadcast loudness.
set -e
in="$1"; out="$2"
ffmpeg -v error -y -i "$in" -filter_complex "[0:a]highpass=f=80,lowpass=f=12000,equalizer=f=180:t=q:w=1.2:g=2,equalizer=f=3200:t=q:w=1.5:g=-1.5,acompressor=threshold=-20dB:ratio=2.5:attack=15:release=120:makeup=2,aecho=0.85:0.25:18:0.05[v];anoisesrc=colour=pink:amplitude=0.03:sample_rate=44100[n];[n]volume=-38dB[nb];[v][nb]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:LRA=9:TP=-1.5[out]" -map "[out]" -c:a libmp3lame -q:a 2 "$out"
