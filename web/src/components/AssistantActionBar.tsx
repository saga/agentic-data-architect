import { Button, Flex, Typography } from 'antd';
import type { SessionContext } from '../app/types';

const { Text } = Typography;

/** 只展示少量可执行的下一步动作，避免把路线说明堆进聊天正文。 */
export function AssistantActionBar(props: {
  routeOptions: NonNullable<SessionContext['journeyPlan']>['routes'];
  followUpQuestions: string[];
  loading: boolean;
  onSelectRoute: (routeId: string) => void;
  onAsk: (question: string) => void;
}) {
  const routes = props.routeOptions.slice(0, 3);
  const questions = props.followUpQuestions.slice(0, 3);
  if (!routes.length && !questions.length) return null;

  return (
    <div className="assistant-action-bar">
      {routes.length ? (
        <>
          <Text type="secondary" className="assistant-action-label">下一步</Text>
          <Flex wrap gap={6}>
            {routes.map((route) => (
              <Button
                key={route.id}
                size="small"
                className="assistant-action-button"
                disabled={props.loading}
                onClick={() => props.onSelectRoute(route.id)}
              >
                {route.title}
              </Button>
            ))}
          </Flex>
        </>
      ) : null}
      {questions.length ? (
        <>
          <Text type="secondary" className="assistant-action-label">继续调查</Text>
          <Flex wrap gap={6}>
            {questions.map((question) => (
              <Button
                key={question}
                size="small"
                type="link"
                className="assistant-action-question"
                disabled={props.loading}
                onClick={() => props.onAsk(question)}
              >
                {question}
              </Button>
            ))}
          </Flex>
        </>
      ) : null}
    </div>
  );
}
