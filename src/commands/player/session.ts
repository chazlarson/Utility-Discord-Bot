import {
  VoiceConnection,
  AudioPlayer,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  AudioPlayerStatus,
} from '@discordjs/voice';
import type { Guild } from 'discord.js';

import { promisify } from 'util';

import { PlayerUpdates } from 'src/models/player-updates';
import { log, error } from 'src/logging';
import { shuffleArray } from 'src/utils';
import { getChannel, isText } from 'src/discord-utils';
import sessions from './sessions';
import Track, { AudioResourceOptions } from './track';
import { getMessageData, listenForPlayerButtons } from './utils';
import { runNowPlaying } from './now-playing';

// https://github.com/discordjs/voice/blob/f1869a9af5a44ec9a4f52c2dd282352b1521427d/examples/music-bot/src/music/subscription.ts
export default class Session {
  public readonly voiceConnection: VoiceConnection;
  public readonly audioPlayer: AudioPlayer;
  private currentTrack: Track | undefined;
  public readonly queue: Track[];
  public readonly queueLoop: Track[] = [];
  private shuffled = false;
  private readonly guild: Guild;
  private queueLock = false;
  private readyLock = false;
  private playbackSpeed = 1;

  // DiscordJS does not provide this for us, so we manually keep track of an approximate duration in the current track
  private currentTrackPlayTime: {
    // all in MS
    started: number | null, // timestamp
    pauseStarted: number | null, // timestamp
    totalPauseTime: number,
    seeked: number | null,
    speed: number,
  } = {
    started: null,
    pauseStarted: null,
    totalPauseTime: 0,
    seeked: null,
    speed: 1,
  };

  public constructor(guild: Guild, voiceConnection: VoiceConnection) {
    this.guild = guild;
    this.voiceConnection = voiceConnection;
    this.audioPlayer = createAudioPlayer();
    this.queue = [];

    this.voiceConnection.on('stateChange', async (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
          // If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
          // but there is a chance the connection will recover itself if the reason of the disconnect was due to
          // switching voice channels. This is also the same code for the bot being kicked from the voice channel,
          // so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
          // the voice connection.
          try {
            // Probably moved voice channel
            await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5_000);
          } catch {
            // Probably removed from voice channel
            sessions.destroy(guild);
          }
        } else if (this.voiceConnection.rejoinAttempts < 5) {
          // The disconnect in this case is recoverable, so we will attempt to reconnect up to 5 times.
          await promisify(setTimeout)((this.voiceConnection.rejoinAttempts + 1) * 5_000);
          this.voiceConnection.rejoin();
        } else {
          // The disconnect in this case may be recoverable, but we've exceeded our retry attempts.
          sessions.destroy(guild);
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        // Once destroyed, stop the subscription
        this.stop();
      } else if (
        !this.readyLock
        && (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling)
      ) {
        // Set a 20 second time limit for the connection to become ready before destroying the voice connection.
        // This stops the voice connection permanently existing in one of these states.
        this.readyLock = true;
        try {
          await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
          sessions.destroy(guild);
        }
        this.readyLock = false;
      }
    });

    // For keeping track of play and pause time
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && this.currentTrackPlayTime.started == null) {
        this.currentTrackPlayTime.started = Date.now();
      }
      if (newState.status !== AudioPlayerStatus.Playing && oldState.status === AudioPlayerStatus.Playing) {
        this.currentTrackPlayTime.pauseStarted = Date.now();
        log('Paused at', this.currentTrackPlayTime.pauseStarted);
      } else if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing) {
        if (this.currentTrackPlayTime.pauseStarted != null) {
          const pausedTime = Date.now() - this.currentTrackPlayTime.pauseStarted;
          log('Resumed after being paused for', pausedTime, 'milliseconds');
          this.currentTrackPlayTime.totalPauseTime += pausedTime;
          this.currentTrackPlayTime.pauseStarted = null;
          log('New total pause time:', this.currentTrackPlayTime.totalPauseTime, 'millseconds');
        }
      }
    });

    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        // If the Idle state is entered from a non-Idle state, it means that an audio resource has finished playing.
        this.processQueue();
      }
    });

    this.audioPlayer.on('error', error);

    voiceConnection.subscribe(this.audioPlayer);
  }

  /**
   * Duplicate tracks without reusing the same ones, since once a track's audio resource gets destroyed,
   * it cannot be reused.
   */
  private duplicateTracks(tracks: Track[]): Track[] {
    return tracks.map(track => new Track(track.link, track.variant));
  }

  public getCurrentTrack(): Track | undefined {
    return this.currentTrack;
  }

  public loop(): void {
    const newQueueLoop = this.duplicateTracks(
      this.currentTrack ? [this.currentTrack].concat(this.queue) : this.queue,
    );
    this.queueLoop.splice(0, this.queueLoop.length, ...newQueueLoop);
  }

  public unloop(): void {
    this.queueLoop.splice(0, this.queueLoop.length);
  }

  public isLooped(): boolean {
    return this.queueLoop.length > 0;
  }

  public isShuffled(): boolean {
    return this.shuffled;
  }

  public shuffle(): void {
    shuffleArray(this.queue);
    shuffleArray(this.queueLoop);
    this.shuffled = true;
  }

  /**
   * Note: This does not restore the original order of the queue,
   * but this means that if the queue is looped, it won't be reshuffled after looping.
   */
  public unshuffle(): void {
    this.shuffled = false;
  }

  public reverse(): void {
    this.queue.splice(0, this.queue.length, ...this.queue.reverse());
  }

  public clear(): void {
    this.queue.splice(0, this.queue.length);
    this.unshuffle();
    this.unloop();
  }

  public remove(idx: number): Track | undefined {
    return this.queue.splice(idx, 1)[0];
  }

  public move(from: number, to: number): Track | undefined {
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    return track;
  }

  public enqueue(tracks: Track[], pushToFront = false): Promise<void> {
    if (this.isShuffled()) shuffleArray(tracks);
    if (pushToFront) {
      this.queue.unshift(...tracks);
    } else {
      this.queue.push(...tracks);
    }
    if (this.isLooped()) {
      if (pushToFront) {
        this.queueLoop.unshift(...this.duplicateTracks(tracks));
      } else {
        this.queueLoop.push(...this.duplicateTracks(tracks));
      }
    }
    return this.processQueue();
  }

  public pause(): boolean {
    return this.audioPlayer.pause();
  }

  public resume(): boolean {
    return this.audioPlayer.unpause();
  }

  public isPaused(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  public stop(): void {
    this.queueLock = true;
    this.queue.splice(0, this.queue.length);
    this.audioPlayer.stop(true);
    this.currentTrackPlayTime = {
      started: null,
      pauseStarted: null,
      totalPauseTime: 0,
      seeked: null,
      speed: this.playbackSpeed,
    };
  }

  /**
   * @param extraSkips If provided, will skip additional songs in the queue instead of just the current track
   */
  public skip(extraSkips = 0): Promise<void> {
    this.queue.splice(0, extraSkips);
    return this.processQueue(true);
  }

  public setPlaybackSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  public getPlaybackSpeed(): number {
    return this.currentTrackPlayTime.speed;
  }

  private getAudioResourceOptions(): AudioResourceOptions {
    return {
      speed: this.playbackSpeed !== 1 ? this.playbackSpeed : undefined,
    };
  }

  public async seek(amountSeconds: number): Promise<void> {
    if (!this.currentTrack) return;
    const resource = await this.currentTrack.getAudioResource({
      ...this.getAudioResourceOptions(),
      seek: amountSeconds,
    });
    this.audioPlayer.play(resource);
    this.currentTrackPlayTime = {
      // It could buffer before starting, so we don't initialize the start time just yet
      started: null,
      seeked: amountSeconds * 1000,
      pauseStarted: null,
      totalPauseTime: 0,
      speed: this.playbackSpeed,
    };
  }

  /**
   * @returns An approximation of the time played in the current resource
   */
  public getCurrentTrackPlayTime(): number {
    if (!this.currentTrackPlayTime.started) return 0;
    const timeSinceStart = Date.now() - this.currentTrackPlayTime.started;
    const totalPauseTime = this.isPaused() && this.currentTrackPlayTime.pauseStarted != null
      ? (Date.now() - this.currentTrackPlayTime.pauseStarted) + this.currentTrackPlayTime.totalPauseTime
      : this.currentTrackPlayTime.totalPauseTime;
    const timePlayed = (timeSinceStart - totalPauseTime) * this.currentTrackPlayTime.speed;
    if (this.currentTrackPlayTime.seeked != null) {
      return timePlayed + this.currentTrackPlayTime.seeked;
    }
    return timePlayed;
  }

  private async processQueue(forceSkip = false): Promise<void> {
    if (this.queueLock) {
      log('Queue lock prevented a problem.');
      return;
    }
    if (!forceSkip && this.audioPlayer.state.status !== AudioPlayerStatus.Idle) return;

    this.queueLock = true;

    if (!this.queue.length && !this.isLooped()) {
      this.shuffled = false;
    }

    // We have exhausted the queue, so refill it and re-shuffle the queue loop if applicable
    if (!this.queue.length && this.isLooped()) {
      this.queue.push(...this.queueLoop);
      const newQueueLoop = this.duplicateTracks(this.queueLoop);
      if (this.shuffled) shuffleArray(newQueueLoop);
      this.queueLoop.splice(0, this.queueLoop.length, ...newQueueLoop);
    }

    this.currentTrack = this.queue.shift();
    if (!this.currentTrack) {
      if (forceSkip) {
        console.log('stopping audio player');
        this.audioPlayer.stop(true);
      }
      this.queueLock = false;
      return;
    }

    try {
      const resource = await this.currentTrack.getAudioResource(this.getAudioResourceOptions());
      this.audioPlayer.play(resource);
      log('Playing new track', this.currentTrack.link, this.currentTrack.variant);

      this.currentTrackPlayTime = {
        // It could buffer before starting, so we don't initialize the start time just yet
        started: null,
        pauseStarted: null,
        totalPauseTime: 0,
        seeked: null,
        speed: this.playbackSpeed,
      };

      // TODO: Extract this to a helper function
      // Also consider baking this into replyWithSessionButtons, but adding an option
      // to specify that we do not want to update the embeded data when buttons are interacted with
      const playerUpdateSetting = await PlayerUpdates.findByPk(this.guild.id);
      if (playerUpdateSetting) {
        const channel = await getChannel(playerUpdateSetting.channel_id);
        if (channel && isText(channel)) {
          const nowPlayingData = await runNowPlaying(this);
          const messageData = await getMessageData({
            session: this,
            run: () => Promise.resolve(nowPlayingData),
          });
          const message = await channel.send(messageData).catch(error);
          if (message) {
            listenForPlayerButtons({
              session: this,
              message,
              cb: async () => {
                const newMessageData = await getMessageData({
                  session: this,
                  run: () => Promise.resolve(nowPlayingData),
                });
                await message.edit(newMessageData);
              },
            });
          }
        }
      }
    } catch (err) {
      error(err);
      log('Could not play track', this.currentTrack.link, this.currentTrack.variant);
      // Skip and try next
      this.queueLock = false;
      await this.processQueue();
    }
    this.queueLock = false;
  }
}
