import React, { useEffect, useState } from 'react';
import { Button, Card, Col, Empty, Flex, Row, Space, Statistic, Tag, Timeline, Typography } from 'antd';
import { ArrowLeftOutlined, ClockCircleOutlined, ReloadOutlined, ToolOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

interface TrajectoryEvent {
  id:string;
  turnId:string;
  timestamp:string;
  type:string;
  name:string;
  status?:string;
  durationMs?:number;
  model?:string;
  inputTokens?:number;
  outputTokens?:number;
  premiumRequestCost?:number;
  details:Record<string,unknown>;
}
interface TrajectorySummary {
  turnId:string;
  startedAt:string;
  finishedAt?:string;
  durationMs?:number;
  model?:string;
  inputTokens:number;
  outputTokens:number;
  totalTokens:number;
  totalNanoAiu?:number;
  totalPremiumRequestCost?:number;
  eventCount:number;
}

function time(value:string){
  const d=new Date(value);
  return Number.isNaN(d.getTime())?value:d.toLocaleTimeString();
}
function duration(ms?:number){
  if(ms===undefined)return '—';
  return ms<1000?(`${Math.round(ms)} ms`):(`${(ms/1000).toFixed(1)} s`);
}

export function AgentTrajectoryPage(props:{sessionName:string;onBack:()=>void}){
  const [events,setEvents]=useState<TrajectoryEvent[]>([]);
  const [summary,setSummary]=useState<TrajectorySummary|null>(null);
  const [loading,setLoading]=useState(false);

  const load=async()=>{
    setLoading(true);
    try{
      const response=await fetch(`/api/sessions/${encodeURIComponent(props.sessionName)}/trajectory?limit=2000`);
      if(!response.ok) throw new Error((await response.text())||response.statusText);
      const data=await response.json() as {events:TrajectoryEvent[];summary:TrajectorySummary|null};
      setEvents(data.events);
      setSummary(data.summary);
    }finally{
      setLoading(false);
    }
  };

  useEffect(()=>{void load()},[props.sessionName]);

  return <div className="trajectory-page-shell">
    <header className="subpage-header">
      <Flex align="center" gap={10}>
        <Button type="text" icon={<ArrowLeftOutlined/>} onClick={props.onBack}>返回调查</Button>
        <Title level={4} style={{margin:0}}>Agent 执行轨迹</Title>
        <Tag>{props.sessionName}</Tag>
      </Flex>
      <Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新</Button>
    </header>
    <div className="trajectory-page-body">
      {!events.length ? <Empty description="还没有保存 Agent 执行轨迹。下一次提问完成后，这里会记录模型调用、工具调用、权限确认、上下文整理和结果。" /> : <>
        <Row gutter={[12,12]} className="trajectory-stat-row">
          <Col xs={24} md={6}><Card><Statistic title="总 Token" value={summary?.totalTokens??0}/></Card></Col>
          <Col xs={24} md={6}><Card><Statistic title="输入 Token" value={summary?.inputTokens??0}/></Card></Col>
          <Col xs={24} md={6}><Card><Statistic title="输出 Token" value={summary?.outputTokens??0}/></Card></Col>
          <Col xs={24} md={6}><Card><Statistic title="AI 额度（nano-AI）" value={summary?.totalNanoAiu??0}/></Card></Col>
        </Row>
        <Card className="trajectory-summary-card">
          <Flex justify="space-between" wrap gap={16}>
            <Space wrap>
              {summary?.model?<Tag>{summary.model}</Tag>:null}
              <Tag icon={<ClockCircleOutlined/>}>{duration(summary?.durationMs)}</Tag>
              <Tag icon={<ToolOutlined/>}>{events.filter(x=>x.type==="tool_call").length} 次工具调用</Tag>
              <Tag>{events.length} 个轨迹事件</Tag>
            </Space>
            {summary?.totalPremiumRequestCost!==undefined?<Text type="secondary">Premium Request Cost：{summary.totalPremiumRequestCost}</Text>:null}
          </Flex>
          <Paragraph type="secondary">这里展示的是 Copilot SDK 提供的运行用量。Premium Request Cost 是计费乘数，不是货币金额；nano-AI 也不要直接当成本金额。</Paragraph>
        </Card>
        <Card title="执行时间线" className="trajectory-timeline-card">
          <Timeline items={events.slice().reverse().map(event=>({
            label:time(event.timestamp),
            color:event.status==="failed"?"red":event.status==="completed"?"green":event.status==="waiting"?"orange":undefined,
            dot:event.type==="tool_call"||event.type==="tool_result"?<ToolOutlined/>:event.type==="model_call"?<span>AI</span>:undefined,
            children:<div>
              <Flex justify="space-between" gap={12}>
                <Text strong>{event.name}</Text>
                <Space size={6}>
                  {event.model?<Tag>{event.model}</Tag>:null}
                  {event.durationMs!==undefined?<Tag>{duration(event.durationMs)}</Tag>:null}
                  {event.inputTokens!==undefined||event.outputTokens!==undefined?<Tag>{(event.inputTokens??0)+(event.outputTokens??0)} tokens</Tag>:null}
                </Space>
              </Flex>
              {event.type==="tool_call" && event.details.arguments ? <Text type="secondary">参数：{String(event.details.arguments).slice(0,300)}</Text>:null}
              {event.type==="tool_result" && event.details.error ? <Text type="danger">{String(event.details.error)}</Text>:null}
              {event.type==="status" && event.details.currentTokens!==undefined ? <Text type="secondary">上下文：{String(event.details.currentTokens)} / {String(event.details.tokenLimit)} tokens</Text>:null}
            </div>
          }))}/>
        </Card>
      </>}
    </div>
  </div>;
}
