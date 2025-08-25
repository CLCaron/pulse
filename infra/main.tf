terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

variable "aws_region" { default = "us-east-1" }
variable "aws_profile" { default = "pulse" }

data "archive_file" "heartbeat_zip" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/build/heartbeat.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "heartbeat_role" {
  name               = "pulse-heartbeat-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_logs" {
  role       = aws_iam_role.heartbeat_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "heartbeat" {
  function_name    = "pulse-heartbeat"
  role             = aws_iam_role.heartbeat_role.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.heartbeat_zip.output_path
  source_code_hash = data.archive_file.heartbeat_zip.output_base64sha256
  timeout          = 15
  environment { variables = { APP_NAME = "Pulse"
    TABLE_NAME = aws_dynamodb_table.items.name
  } }
}

resource "aws_cloudwatch_log_group" "heartbeat" {
  name              = "/aws/lambda/${aws_lambda_function.heartbeat.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_event_rule" "every_15_min" {
  name                = "pulse-heartbeat-schedule"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "heartbeat_target" {
  rule      = aws_cloudwatch_event_rule.every_15_min.name
  target_id = "heartbeat"
  arn       = aws_lambda_function.heartbeat.arn
}

resource "aws_lambda_permission" "allow_events" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.heartbeat.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_15_min.arn
}

resource "aws_dynamodb_table" "items" {
  name         = "pulse_items"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

data "aws_iam_policy_document" "lambda_items_write" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:DescribeTable"
    ]
    resources = [aws_dynamodb_table.items.arn]
  }
}

resource "aws_iam_policy" "lambda_items_write" {
  name   = "pulse-lambda-items-write"
  policy = data.aws_iam_policy_document.lambda_items_write.json
}

resource "aws_iam_role_policy_attachment" "lambda_items_write_attach" {
  role       = aws_iam_role.heartbeat_role.name
  policy_arn = aws_iam_policy.lambda_items_write.arn
}

data "aws_iam_policy_document" "lambda_items_read" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:Scan",
      "dynamodb:DescribeTable"
      #TODO Add query later when I create GSI
    ]
    resources = [aws_dynamodb_table.items.arn]
  }
}

resource "aws_iam_policy" "lambda_items_read" {
  name   = "pulse-lambda-items-read"
  policy = data.aws_iam_policy_document.lambda_items_read.json
}

resource "aws_iam_role_policy_attachment" "lambda_items_read_attach" {
  role       = aws_iam_role.heartbeat_role.name
  policy_arn = aws_iam_policy.lambda_items_read.arn
}

data "archive_file" "get_items_zip" {
  type        = "zip"
  source_dir  = "${path.module}/get_items"
  output_path = "${path.module}/build/get_items.zip"
}

resource "aws_lambda_function" "get_items" {
  function_name    = "pulse-get-items"
  role             = aws_iam_role.heartbeat_role.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.get_items_zip.output_path
  source_code_hash = data.archive_file.get_items_zip.output_base64sha256
  timeout          = 10
  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.items.name
    }
  }
}

resource "aws_apigatewayv2_api" "http_api" {
  name          = "pulse-http"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "OPTIONS"]
    allow_headers = ["content-type"]
  }
}

resource "aws_apigatewayv2_integration" "get_items_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_items.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_items_route" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /items"
  target    = "integrations/${aws_apigatewayv2_integration.get_items_integration.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "allow_apigw_get_items" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_items.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

output "api_url" {
  value = aws_apigatewayv2_api.http_api.api_endpoint
}

output "lambda_name" { value = aws_lambda_function.heartbeat.function_name }
