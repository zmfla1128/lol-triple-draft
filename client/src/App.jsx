import React, { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SOCKET_URL || `http://${window.location.hostname}:4000`);

const TEAM_LABELS = { BLUE: "블루 팀", RED: "레드 팀" };
const PHASE_LABELS = { DRAFT: "드래프트", SWAP: "스왑" };
const ROLE_LABELS = ["탑", "정글", "미드", "원딜", "서폿"];

const getMeta = (state, championId) => state?.championCatalog?.[championId] || { id: championId, kr: championId };
const championImage = (state, championId) => {
  const meta = getMeta(state, championId);
  if (meta.image) return meta.image;
  const version = state?.championVersion || "16.9.1";
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${meta.id}.png`;
};

function TeamPanel({ state, team, picks, phase, onSwap }) {
  return (
    <section className={`team-panel ${team.toLowerCase()}`}>
      <h2>{TEAM_LABELS[team] || team}</h2>
      <ul>
        {ROLE_LABELS.map((role, idx) => {
          const championId = picks[idx];
          const meta = championId ? getMeta(state, championId) : null;
          return (
            <li key={`${team}-${role}`}>
              <span className="champion-row">
                <span className="role-label">{role}</span>
                {championId ? (
                  <>
                    <img className="champion-icon" src={championImage(state, championId)} alt={meta.kr} />
                    <span>{meta.kr}</span>
                  </>
                ) : (
                  <span className="empty-slot">미선택</span>
                )}
              </span>
              {phase === "SWAP" && championId && (
                <span className="swap-buttons">
                  <button disabled={idx === 0} onClick={() => onSwap(team, idx, idx - 1)}>위</button>
                  <button disabled={idx === ROLE_LABELS.length - 1 || !picks[idx + 1]} onClick={() => onSwap(team, idx, idx + 1)}>아래</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);

  useEffect(() => {
    const onState = (nextState) => setState(nextState);
    const onTeamSelected = ({ team }) => setSelectedTeam(team);
    socket.on("state:update", onState);
    socket.on("team:selected", onTeamSelected);
    return () => {
      socket.off("state:update", onState);
      socket.off("team:selected", onTeamSelected);
    };
  }, []);

  const pickCount = useMemo(() => (!state ? 0 : state.teams.BLUE.length + state.teams.RED.length), [state]);

  const handleTeamSelect = (team) => {
    setSelectedTeam(team);
    socket.emit("team:select", { team });
  };

  if (!state) return <div className="loading">서버에 연결 중...</div>;

  if (!selectedTeam) {
    return (
      <main className="page">
        <h1>LoL 트리플 드래프트</h1>
        <section className="offers">
          <h3>시작 전 팀을 선택하세요</h3>
          <div className="team-choice">
            <button className="choice blue" onClick={() => handleTeamSelect("BLUE")}>블루 팀</button>
            <button className="choice red" onClick={() => handleTeamSelect("RED")}>레드 팀</button>
          </div>
        </section>
      </main>
    );
  }

  const handlePick = (championId) => {
    if (state.currentTeam !== selectedTeam) return;
    socket.emit("draft:pick", { champion: championId });
  };

  const handleSwap = (team, fromIndex, toIndex) => socket.emit("swap:move", { team, fromIndex, toIndex });
  const handleReset = () => socket.emit("game:reset");

  return (
    <main className="page">
      <h1>LoL 트리플 드래프트</h1>
      <div className="status">
        <p><strong>단계:</strong> {PHASE_LABELS[state.phase] || state.phase}</p>
        <p><strong>현재 턴:</strong> {state.currentTeam ? TEAM_LABELS[state.currentTeam] : "-"}</p>
        <p><strong>내 팀:</strong> {TEAM_LABELS[selectedTeam]}</p>
        <p><strong>선택 수:</strong> {pickCount} / 10</p>
      </div>
      {state.phase === "DRAFT" && (
        <section className="offers">
          <h3>챔피언 1명 선택 ({TEAM_LABELS[state.currentTeam]})</h3>
          <div className="cards">
            {state.offeredChampions.map((championId) => {
              const meta = getMeta(state, championId);
              return (
                <button key={championId} className="card" disabled={state.currentTeam !== selectedTeam} onClick={() => handlePick(championId)}>
                  <img className="card-image" src={championImage(state, championId)} alt={meta.kr} />
                  <span className="card-name">{meta.kr}</span>
                </button>
              );
            })}
          </div>
          {state.currentTeam !== selectedTeam && <p className="turn-wait">상대 팀 턴입니다. 잠시 기다려주세요.</p>}
        </section>
      )}
      {state.phase === "SWAP" && (
        <section className="offers">
          <h3>스왑 단계: 같은 팀 내 챔피언 순서를 변경하세요</h3>
        </section>
      )}
      <div className="teams">
        <TeamPanel state={state} team="BLUE" picks={state.teams.BLUE} phase={state.phase} onSwap={handleSwap} />
        <TeamPanel state={state} team="RED" picks={state.teams.RED} phase={state.phase} onSwap={handleSwap} />
      </div>
      <button className="reset" onClick={handleReset}>드래프트 초기화</button>
    </main>
  );
}
